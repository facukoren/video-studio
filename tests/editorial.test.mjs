import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePlan, preparePlan, normalizeTranscript, EditorialClient} from '../src/providers/editorial.mjs';

const words=['Una','computadora','ahorra','3','horas.'].map((text,i)=>({text,start:i*.6,end:i*.6+.5}));
const plan=()=>({creativeIntent:'Mostrar el ahorro de tiempo mediante una cifra concreta.',captionGroups:[{startWord:0,endWord:1,emphasis:[],position:'lower'},{startWord:2,endWord:4,emphasis:[3],position:'lower'}],zooms:[],overlays:[{kind:'counter',startWord:2,endWord:4,text:'Tiempo ahorrado',secondaryText:'',valueFrom:0,valueTo:3,suffix:' horas',position:'upper',evidenceStartWord:2,evidenceEndWord:4}],brolls:[{start:0,duration:3,prompt:'A person completing a work task on a desktop computer',quote:'Una computadora'}]});
const visualContext={images:['/private/reference.png','/private/source.png'],reference:{sha256:'a'.repeat(64)},source:{sha256:'b'.repeat(64),width:1080,height:1920}};
const v3Plan=()=>({...plan(),visualStyle:'kavion-clavicular-v1',scenes:[],soundCues:[],framing:{focusX:.5,focusY:.4}});
const metadata={provider:'codex-cli',model:'gpt-6-astra',effort:'high',fingerprint:'input-fingerprint'};

test('normalizes word transcription without inventing missing or overlapping times',()=>{
  assert.deepEqual(normalizeTranscript({segments:[{words:[{word:'Hola',start:0.2,end:0.5}]}]}),[{text:'Hola',start:0.2,end:0.5}]);
  assert.throws(()=>normalizeTranscript({segments:[{words:[{word:'Hola'}]}]}),/tiempos/i);
  assert.throws(()=>normalizeTranscript({words:[{text:'Hola',start:0,end:1},{text:'mundo',start:.5,end:2}]}),/tiempos/i);
});
test('B-roll validation requires real transcript anchors and bounded duration',()=>{
  const valid=plan();
  assert.equal(validatePlan(valid,words,3,2).brolls.length,1);
  assert.throws(()=>validatePlan({...valid,brolls:[{...valid.brolls[0],start:10}]},words,3,2),/tiempo/i);
  assert.throws(()=>validatePlan({...valid,brolls:[{...valid.brolls[0],quote:'perro invisible'}]},words,3,2),/guion/i);
  assert.throws(()=>validatePlan({brolls:[]},words,3,2),/B-roll/i);
});
test('historical plan preparation records discarded overlaps without shifting time',()=>{
  const transcript=[{text:'ideas',start:0,end:1}];
  const early={start:.1,duration:.2,prompt:'A notebook filled with colorful ideas',quote:'ideas'};
  const later={start:.3,duration:.2,prompt:'A pencil beside an open notebook',quote:'ideas'};
  const rawPlan={brolls:[later,early],note:'upstream annotation'};
  assert.throws(()=>validatePlan(rawPlan,transcript,1),/superpuestos/);
  assert.deepEqual(preparePlan(rawPlan,transcript,1),{brolls:[early],adjustments:[{candidateIndex:0,reason:'overlap'}],rawPlan});
});
test('historical preparation enforces count cap before filtering invalid candidates',()=>{
  const valid=plan().brolls[0];
  assert.throws(()=>preparePlan({brolls:[{...valid,quote:'inexistente'},valid,valid]},words,3),/límite/);
  assert.throws(()=>preparePlan({brolls:[{...valid,quote:'inexistente'}]},words,3),/B-roll/);
});

test('Astra review preserves retained words and records exact model provenance',async()=>{
  const requests=[];
  const client=new EditorialClient({}, {astra:{run:async request=>{requests.push(request);return {value:{cuts:[{startWord:0,endWord:0,reason:'Arranque incompleto antes de la frase definitiva.'}]},metadata};}}});
  assert.equal(typeof client.review,'function');
  const result=await client.review(words,{duration:3,width:1080,height:1920},'/private/job');
  assert.deepEqual(result.words,words.slice(1));assert.equal(result.model,'gpt-6-astra');assert.equal(result.effort,'high');
  assert.equal(result.provenance.fingerprint,'input-fingerprint');
  assert.equal(requests[0].name,'editorial-review');assert.match(requests[0].prompt,/0.*Una/s);assert.ok(requests[0].schema.properties.cuts);
});
test('Astra composition returns semantic choices and a stable validated-plan fingerprint',async()=>{
  const requests=[];
  const client=new EditorialClient({}, {astra:{run:async request=>{requests.push(request);return {value:v3Plan(),metadata};}}});
  const result=await client.plan(words,3,2,'/private/job',visualContext);
  assert.equal(result.overlays[0].kind,'counter');assert.equal(result.captionGroups[1].emphasis[0],3);
  assert.equal(result.schemaVersion,3);assert.equal(result.model,'gpt-6-astra');assert.match(result.planFingerprint,/^[a-f0-9]{64}$/);
  assert.equal(requests[0].name,'creative-plan');assert.equal(requests[0].schema.properties.brolls.maxItems,2);
  const repeated=await client.plan(words,3,2,'/private/job',visualContext);assert.equal(repeated.planFingerprint,result.planFingerprint);
});
test('invalid creative output receives one bounded Astra repair and never a generic fallback',async()=>{
  let requests=[];
  const bad={...v3Plan(),captionGroups:[]};
  const client=new EditorialClient({}, {astra:{run:async request=>{requests.push(request);return {value:requests.length===1?bad:v3Plan(),metadata};}}});
  const result=await client.plan(words,3,2,'/private/job',visualContext);
  assert.equal(requests.length,2);assert.equal(requests[1].name,'creative-plan-repair');assert.match(requests[1].prompt,/Subtítulos/);assert.equal(result.overlays.length,1);
  requests=[];
  const broken=new EditorialClient({}, {astra:{run:async request=>{requests.push(request);return {value:bad,metadata};}}});
  await assert.rejects(()=>broken.plan(words,3,2,'/private/job',visualContext),/Subtítulos/);assert.equal(requests.length,2);
});
test('unavailable or wrong Astra model stops without fallback or repair inference',async()=>{
  let calls=0;
  const client=new EditorialClient({}, {astra:{run:async()=>{calls++;throw new Error('Astra no disponible');}}});
  await assert.rejects(()=>client.plan(words,3,2,'/private/job',visualContext),/Astra no disponible/);assert.equal(calls,1);
  const wrong=new EditorialClient({}, {astra:{run:async()=>({value:v3Plan(),metadata:{...metadata,model:'other'}})}});
  await assert.rejects(()=>wrong.plan(words,3,2,'/private/job',visualContext),/Astra|modelo/i);
});
test('local transcription word arrays flow into editorial review without changed text',async()=>{
  const client=new EditorialClient({}, {transcriber:{transcribe:async()=>words}});
  assert.deepEqual(await client.transcribe('/private/source.mp4','/private/job'),words);
});
test('equivalent model JSON key order does not change the frozen plan identity',async()=>{
  let changed=false;
  const client=new EditorialClient({}, {astra:{run:async()=>{const value=v3Plan();if(changed)value.overlays=value.overlays.map(item=>Object.fromEntries(Object.entries(item).reverse()));return {value,metadata};}}});
  const first=await client.plan(words,3,2,'/private/job',visualContext);changed=true;
  const second=await client.plan(words,3,2,'/private/job',visualContext);assert.equal(second.planFingerprint,first.planFingerprint);
});
test('Astra receives versioned HyperFrames editorial guidance and records its source identity',async()=>{
  const requests=[];
  const client=new EditorialClient({}, {astra:{run:async request=>{requests.push(request);return {value:v3Plan(),metadata};}}});
  const result=await client.plan(words,3,2,'/private/job',visualContext);
  assert.match(requests[0].prompt,/2–5 palabras/);assert.match(requests[0].prompt,/30.*47/s);assert.match(requests[0].prompt,/1440/);
  assert.equal(result.editorialGuidance.hyperframesVersion,'0.8.186');
  assert.match(result.editorialGuidance.contentHash,/^[a-f0-9]{64}$/);
  assert.ok(result.editorialGuidance.sources.some(item=>item.path==='references/captions.md'));
});

test('reference imagery survives plan repair and changes the plan identity',async()=>{
 const requests=[];const client=new EditorialClient({}, {astra:{run:async request=>{requests.push(request);return {value:requests.length===1?{...v3Plan(),captionGroups:[]}:v3Plan(),metadata};}}});
 const first=await client.plan(words,3,2,'/private/job',visualContext);
 assert.deepEqual(requests[0].images,visualContext.images);assert.deepEqual(requests[1].images,visualContext.images);
 assert.match(first.visualContextFingerprint,/^[a-f0-9]{64}$/);
 const second=await client.plan(words,3,2,'/private/job',{...visualContext,reference:{sha256:'c'.repeat(64)}});
 assert.notEqual(first.planFingerprint,second.planFingerprint);
});
test('missing reference stops before inference and fixed paid B-rolls cannot be altered',async()=>{
 let calls=0;const client=new EditorialClient({}, {astra:{run:async()=>{calls++;return {value:v3Plan(),metadata};}}});
 await assert.rejects(()=>client.plan(words,3,2,'/private/job'),/referencia/i);assert.equal(calls,0);
 const lockedBrolls=[{...plan().brolls[0],duration:2}];
 await assert.rejects(()=>client.plan(words,3,2,'/private/job',{...visualContext,lockedBrolls}),/B-roll.*fij|fij.*B-roll/i);
 assert.equal(calls,2);
});
test('visual critique preserves failure and rejects contradictory or unbounded approvals',async()=>{
 const requests=[];let response={ok:false,issues:['El gráfico tapa el rostro.'],summary:'Hay que corregir el encuadre.'};
 const client=new EditorialClient({}, {astra:{run:async request=>{requests.push(request);return {value:response,metadata};}}});
 const input={images:visualContext.images,reference:visualContext.reference,plan:v3Plan(),words,duration:3};
 const critique=await client.reviewVisual(input,'/private/job');
 assert.equal(critique.ok,false);assert.equal(critique.model,'gpt-6-astra');assert.deepEqual(requests[0].images,input.images);assert.equal(requests[0].name,'visual-review');
 response={ok:true,issues:['Rostro cubierto'],summary:'Correcto'};
 await assert.rejects(()=>client.reviewVisual(input,'/private/job'),/revisión|visual|contradict/i);
 response={ok:true,issues:[],summary:'x'.repeat(1201)};
 await assert.rejects(()=>client.reviewVisual(input,'/private/job'),/revisión|Resumen|visual/i);
});
test('fixed paid B-rolls remain byte-for-byte data equivalent in an accepted plan',async()=>{
 const requests=[];const client=new EditorialClient({}, {astra:{run:async request=>{requests.push(request);return {value:v3Plan(),metadata};}}});
 const lockedBrolls=plan().brolls;
 const result=await client.plan(words,3,2,'/private/job',{...visualContext,lockedBrolls});
 assert.deepEqual(result.brolls,lockedBrolls);assert.ok(requests[0].prompt.includes(JSON.stringify(lockedBrolls)));
});
test('visual critique repair retains images and exact-model enforcement',async()=>{
 const requests=[];const input={images:visualContext.images,reference:visualContext.reference,plan:v3Plan(),words,duration:3};
 const client=new EditorialClient({}, {astra:{run:async request=>{requests.push(request);return {value:requests.length===1?{ok:false,issues:[],summary:'Contradictorio'}:{ok:true,issues:[],summary:'No hay defectos visuales en los cuadros.'},metadata};}}});
 const result=await client.reviewVisual(input,'/private/job');assert.equal(result.ok,true);assert.equal(result.effort,'high');assert.deepEqual(requests[1].images,input.images);
 const wrong=new EditorialClient({}, {astra:{run:async()=>({value:{ok:true,issues:[],summary:'Sí'},metadata:{...metadata,effort:'low'}})}});
 await assert.rejects(()=>wrong.reviewVisual(input,'/private/job'),/Astra High/);
});
test('Astra receives qualitative scene emphasis without invented numerical ratios',async()=>{
 let request;const client=new EditorialClient({}, {astra:{run:async input=>{request=input;return {value:v3Plan(),metadata};}}});
 await client.plan(words,3,2,'/private/job',visualContext);
 assert.match(request.prompt,/emphasis.*subdued.*normal.*prominent/s);
 assert.match(request.prompt,/contraste.*hablado|contraste.*guion/s);
 assert.match(request.prompt,/no infieras.*proporciones numéricas/i);
 assert.ok(request.schema.properties.scenes.items.properties.items.items.required.includes('emphasis'));
});

test('automatic visual repair passes the concrete critique as untrusted data',async()=>{
 let request;const client=new EditorialClient({}, {astra:{run:async input=>{request=input;return {value:v3Plan(),metadata};}}});
 const repairFeedback={issues:['El panel tapa el rostro.'],summary:'Corregir encuadre.'};
 await client.plan(words,3,2,'/private/recovery/visual-1',{...visualContext,lockedBrolls:plan().brolls,repairFeedback});
 assert.ok(request.prompt.includes(JSON.stringify(repairFeedback)));assert.match(request.prompt,/datos.*no.*instrucciones/i);
});

test('B-roll repair chooses bounded blur rectangles from actual asset contact sheets',async()=>{
 let request;const proposal={repairs:[{index:0,regions:[{x:.1,y:.2,width:.5,height:.4}]}]};
 const client=new EditorialClient({}, {astra:{run:async input=>{request=input;return {value:proposal,metadata};}}});
 const input={images:['/private/broll-sheet.jpg'],brolls:[{index:0,...plan().brolls[0]}],issues:['Las letras de la interfaz están deformadas.'],samples:[{index:0,imageIndices:[0],times:[.2,1.5,2.85]}]};
 assert.deepEqual(await client.repairBrollPlan(input,'/private/recovery/visual-1'),proposal);
 assert.deepEqual(request.images,input.images);assert.equal(request.name,'broll-repair-plan');assert.ok(request.schema.properties.repairs);assert.ok(request.prompt.includes(JSON.stringify(input.issues)));assert.match(request.prompt,/no confiables.*nunca instrucciones/i);assert.match(request.prompt,/desenfo|blur/i);
});

test('B-roll repair accepts no treatment for composition defects and rejects unsafe proposals',async()=>{
 const input={images:['/private/broll-sheet.jpg'],brolls:[{index:0,...plan().brolls[0]}],issues:['Un gráfico cubre el rostro.'],samples:[{index:0,imageIndices:[0],times:[.2,1.5,2.85]}]};
 const client=value=>new EditorialClient({}, {astra:{run:async()=>({value,metadata})}});
 assert.deepEqual(await client({repairs:[]}).repairBrollPlan(input,'/private/job'),{repairs:[]});
 const region={x:.1,y:.1,width:.5,height:.5};
 for(const proposal of [
  {repairs:[{index:1,regions:[region]}]},
  {repairs:[{index:0,regions:[{...region,x:NaN}]}]},
  {repairs:[{index:0,regions:[{...region,x:.8}]}]},
  {repairs:[{index:0,regions:[{x:0,y:0,width:1,height:.8}]}]},
  {repairs:[{index:0,regions:[region,region,region]}]},
  {repairs:[{index:0,regions:[{...region,filter:'arbitrary'}]}]},
  {repairs:[{index:0,regions:[region]},{index:0,regions:[region]}]},
 ])await assert.rejects(client(proposal).repairBrollPlan(input,'/private/job'),/regi.n|repar|B-roll|.ndice/i);
});

test('B-roll repair reprompts when new blur exceeds cumulative coverage',async()=>{
 const requests=[],previous={x:0,y:0,width:.6,height:1},excessive={x:.4,y:0,width:.6,height:1},safe={x:.6,y:0,width:.05,height:1};
 const client=new EditorialClient({}, {astra:{run:async input=>{requests.push(input);return {value:{repairs:[{index:0,regions:[requests.length===1?excessive:safe]}]},metadata};}}});
 const input={images:['/private/broll-sheet.jpg'],brolls:[{index:0,...plan().brolls[0],repairRegions:[previous]}],issues:['Todavía hay letras deformadas.'],samples:[{index:0,imageIndices:[0],times:[.2,1.5,2.85]}]};
 const result=await client.repairBrollPlan(input,'/private/job');assert.equal(requests.length,2);assert.deepEqual(result.repairs[0].regions,[safe]);assert.match(requests[1].prompt,/acumulad/i);assert.ok(requests[0].prompt.includes(JSON.stringify([previous])));
});

test('B-roll repair rejects corrupt prior region metadata even when proposing no new treatment',async()=>{
 const client=new EditorialClient({}, {astra:{run:async()=>({value:{repairs:[]},metadata})}});
 const input={images:['/private/broll-sheet.jpg'],brolls:[{index:0,...plan().brolls[0],repairRegions:[{x:NaN,y:0,width:.6,height:1}]}],issues:['Composición incorrecta.'],samples:[{index:0,imageIndices:[0],times:[.2,1.5,2.85]}]};
 await assert.rejects(client.repairBrollPlan(input,'/private/job'),/regi.n|repar|B-roll/i);
});

test('B-roll repair proposes timed masks from dense samples and preserves intentional screen soft focus',async()=>{
 let request;const region={x:.1,y:.1,width:.5,height:.3,start:.25,end:1.5};
 const client=new EditorialClient({}, {astra:{run:async input=>{request=input;return {value:{repairs:[{index:0,regions:[region]}]},metadata};}}});
 const times=Array.from({length:12},(_,i)=>(i+.5)*3/12);
 const input={images:['/private/sheet-0.jpg','/private/sheet-1.jpg'],brolls:[{index:0,...plan().brolls[0],prompt:'A person holding a phone with softly blurred people on screen, no readable UI.'}],issues:['La interfaz falsa se mueve por la pantalla.'],samples:[{index:0,imageIndices:[0,1],times}]};
 assert.deepEqual((await client.repairBrollPlan(input,'/private/job')).repairs[0].regions,[region]);
 assert.ok(request.schema.properties.repairs.items.properties.regions.items.required.includes('start'));assert.ok(request.schema.properties.repairs.items.properties.regions.items.required.includes('end'));
 assert.match(request.prompt,/prompt original|brief original/i);assert.match(request.prompt,/rostros.*pantalla.*desenfoc|desenfoc.*rostros.*pantalla/i);assert.match(request.prompt,/start.*end/s);assert.match(request.prompt,/ventanas|intervalos/i);assert.deepEqual(request.images,input.images);
});

test('B-roll repair rejects incomplete or invalid timed masks and out-of-duration history',async()=>{
 const client=region=>new EditorialClient({}, {astra:{run:async()=>({value:{repairs:[{index:0,regions:[region]}]},metadata})}});
 const base={x:.1,y:.1,width:.3,height:.3},input={images:['/private/sheet.jpg'],brolls:[{index:0,...plan().brolls[0]}],issues:['Letras deformadas.'],samples:[{index:0,imageIndices:[0],times:[.2,1.5,2.85]}]};
 for(const region of [{...base,start:0},{...base,end:1},{...base,start:-.1,end:1},{...base,start:1,end:1},{...base,start:1,end:.5},{...base,start:0,end:Infinity},{...base,start:0,end:3.01}])await assert.rejects(client(region).repairBrollPlan(input,'/private/job'),/regi.n|repar|B-roll/i);
 const historical=new EditorialClient({}, {astra:{run:async()=>({value:{repairs:[]},metadata})}});
 await assert.rejects(historical.repairBrollPlan({...input,brolls:[{...input.brolls[0],repairRegions:[{...base,start:0,end:3.01}]}]},'/private/job'),/regi.n|repar|B-roll/i);
});

test('B-roll repair may omit one unsuitable purchased clip while retaining another',async()=>{
 let request;const client=new EditorialClient({}, {astra:{run:async input=>{request=input;return {value:{repairs:[],omitIndices:[0]},metadata};}}});
 const input={images:['/private/bad.jpg','/private/good.jpg'],brolls:[{index:0,...plan().brolls[0],repairRegions:[{x:0,y:0,width:.5,height:.5}]},{index:1,...plan().brolls[0]}],issues:['El desenfoque previo tapa el pulgar; el segundo B-roll está bien.'],samples:[{index:0,imageIndices:[0],times:[.2,1.5,2.85]},{index:1,imageIndices:[1],times:[.2,1.5,2.85]}]};
 assert.deepEqual(await client.repairBrollPlan(input,'/private/job'),{repairs:[],omitIndices:[0]});assert.ok(request.schema.required.includes('omitIndices'));assert.match(request.prompt,/omitIndices/);assert.match(request.prompt,/irreparable|no.*repar.*segur/i);
});

test('B-roll omission cannot remove all clips, duplicate indices or overlap treatment',async()=>{
 const input={images:['/private/one.jpg','/private/two.jpg'],brolls:[{index:0,...plan().brolls[0]},{index:1,...plan().brolls[0]}],issues:['Interfaz incoherente.'],samples:[{index:0,imageIndices:[0],times:[.2,1.5,2.85]},{index:1,imageIndices:[1],times:[.2,1.5,2.85]}]};
 for(const value of [{repairs:[],omitIndices:null},{repairs:[],omitIndices:[0,1]},{repairs:[],omitIndices:[0,0]},{repairs:[],omitIndices:[2]},{repairs:[],omitIndices:[-1]},{repairs:[{index:0,regions:[{x:0,y:0,width:.2,height:.2}]}],omitIndices:[0]}]){
  const client=new EditorialClient({}, {astra:{run:async()=>({value,metadata})}});await assert.rejects(client.repairBrollPlan(input,'/private/job'),/regi.n|repar|B-roll|omisi.n/i);
 }
 const only=new EditorialClient({}, {astra:{run:async()=>({value:{repairs:[],omitIndices:[0]},metadata})}});
 await assert.rejects(only.repairBrollPlan({...input,images:input.images.slice(0,1),brolls:input.brolls.slice(0,1),samples:input.samples.slice(0,1)},'/private/job'),/B-roll|omisi.n/i);
});

test('B-roll selection schema stays compatible with the strict provider boundary',async()=>{
 let submittedSchema;const client=new EditorialClient({}, {astra:{run:async request=>{submittedSchema=request.schema;if(JSON.stringify(request.schema).includes('"uniqueItems"'))throw new Error('Invalid schema: uniqueItems is not permitted when strict=true.');return {value:{repairs:[],omitIndices:[]},metadata};}}});
 const input={images:['/private/broll-sheet.jpg'],brolls:[{index:0,...plan().brolls[0]}],issues:['Revisar la interfaz.'],samples:[{index:0,imageIndices:[0],times:[.2,1.5,2.85]}]};
 assert.deepEqual(await client.repairBrollPlan(input,'/private/job'),{repairs:[],omitIndices:[]});assert.ok(submittedSchema.required.includes('omitIndices'));assert.equal(Object.hasOwn(submittedSchema.properties.omitIndices,'uniqueItems'),false);
});
