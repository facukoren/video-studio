import test from 'node:test';
import assert from 'node:assert/strict';

const editing = await import('../src/edit-plan.mjs').catch(() => ({}));
const words = ['Yo', 'yo', 'ahorro', '3', 'segundos', 'y', '2', 'horas'].map((text, i) => ({text, start:i * .5, end:i * .5 + .4}));
const creative = () => ({
  creativeIntent:'Mostrar el contraste concreto entre tres segundos y dos horas.',
  captionGroups:[{startWord:0,endWord:2,emphasis:[2],position:'lower'},{startWord:3,endWord:4,emphasis:[3],position:'lower'},{startWord:5,endWord:7,emphasis:[6],position:'lower'}],
  zooms:[{startWord:2,endWord:4,scale:1.12,position:'upper'}],
  overlays:[{kind:'comparison',startWord:3,endWord:7,text:'3 segundos',secondaryText:'2 horas',valueFrom:0,valueTo:0,suffix:'',position:'upper',evidenceStartWord:3,evidenceEndWord:7}],
  brolls:[{start:.5,duration:1.5,prompt:'A person completing a task efficiently at a laptop',quote:'yo ahorro 3'}],
});

test('editorial cuts remove complete source words and retain their exact text and timestamps', () => {
  assert.equal(typeof editing.validateReview, 'function');
  const result = editing.validateReview({cuts:[{startWord:0,endWord:0,reason:'Arranque repetido antes de la frase completa.'}]}, words);
  assert.deepEqual(result.words, words.slice(1));
  assert.equal(result.words[0], words[1]);
  assert.deepEqual(result.cuts,[{startWord:0,endWord:0,reason:'Arranque repetido antes de la frase completa.'}]);
});

test('editorial review rejects out of range, overlapping, excessive, and rewritten cuts', () => {
  assert.equal(typeof editing.validateReview, 'function');
  const cut={startWord:0,endWord:0,reason:'Arranque repetido antes de la frase completa.'};
  for(const cuts of [[{...cut,startWord:-1}], [{...cut,endWord:8}], [cut,cut], [{...cut,endWord:6}], [{...cut,replacement:'Una voz diferente'}]]) assert.throws(()=>editing.validateReview({cuts},words));
  assert.deepEqual(editing.validateReview({cuts:[]},words).words,words);
});

test('creative plan preserves Astra grouping and semantic overlay choices', () => {
  assert.equal(typeof editing.validateCreativePlan,'function');
  const result=editing.validateCreativePlan(creative(),words,4,2);
  assert.equal(result.overlays[0].kind,'comparison');
  assert.equal(result.captionGroups[0].endWord,2);
  assert.equal(result.zooms[0].scale,1.12);
  assert.equal(result.brolls[0].quote,'yo ahorro 3');
});

test('creative plan rejects missing, duplicate, reordered captions and invalid emphasis', () => {
  assert.equal(typeof editing.validateCreativePlan,'function');
  const p=creative();
  for(const captionGroups of [p.captionGroups.slice(1),[p.captionGroups[0],...p.captionGroups],p.captionGroups.toReversed(),[{...p.captionGroups[0],emphasis:[5]},...p.captionGroups.slice(1)]]) assert.throws(()=>editing.validateCreativePlan({...p,captionGroups},words,4));
});

test('creative plan rejects unsafe capabilities, invalid anchors, extreme zooms and ungrounded numbers', () => {
  assert.equal(typeof editing.validateCreativePlan,'function');
  const p=creative(), overlay=p.overlays[0];
  for(const patch of [{html:'<script>fetch(secret)</script>'},{zooms:[{...p.zooms[0],scale:9}]},{overlays:[{...overlay,startWord:99}]},{overlays:[{...overlay,kind:'iframe'}]},{overlays:[{...overlay,text:'999 segundos'}]},{overlays:[{...overlay,src:'https://example.com'}]}]) assert.throws(()=>editing.validateCreativePlan({...p,...patch},words,4));
});

test('creative plan rejects overlay and zoom overlap while allowing concurrent separate tracks', () => {
  assert.equal(typeof editing.validateCreativePlan,'function');
  const p=creative();
  assert.throws(()=>editing.validateCreativePlan({...p,overlays:[...p.overlays,...p.overlays]},words,4),/superp|overlap/i);
  assert.throws(()=>editing.validateCreativePlan({...p,zooms:[...p.zooms,...p.zooms]},words,4),/superp|overlap/i);
  assert.equal(editing.validateCreativePlan(p,words,4).zooms.length,1);
});
test('centered graphics cannot cover concurrently centered captions',()=>{
  const p=creative();
  p.overlays[0].position='center';p.captionGroups[1].position='center';
  assert.throws(()=>editing.validateCreativePlan(p,words,4),/posición|superp|subtítulo/i);
});
test('ordinary article words in headlines are not interpreted as invented numbers',()=>{
  const p=creative();p.overlays[0]={...p.overlays[0],kind:'headline',text:'Un gran ahorro',secondaryText:''};
  assert.equal(editing.validateCreativePlan(p,words,4).overlays[0].text,'Un gran ahorro');
});

const referencePlan=()=>({...creative(),visualStyle:'kavion-clavicular-v1',framing:{focusX:.5,focusY:.4},overlays:[],brolls:[{...creative().brolls[0],start:0,duration:.4,quote:'Yo'}],scenes:[{kind:'comparison',startWord:3,endWord:7,kicker:'Tiempo',title:'Comparación',accent:'Ahorro',items:[{label:'3 segundos',icon:'clock'},{label:'2 horas',icon:'check'}],value:0,unit:'',evidenceStartWord:3,evidenceEndWord:7}],soundCues:[{word:3,kind:'whoosh',gain:.1}]});
test('v3 preserves reference scenes and v2 remains readable',()=>{
 const result=editing.validateCreativePlan(referencePlan(),words,4);
 assert.equal(editing.EDIT_PLAN_VERSION,3);assert.equal(result.visualStyle,'kavion-clavicular-v1');assert.equal(result.scenes[0].items[0].icon,'clock');assert.equal(result.framing.focusY,.4);
 assert.equal(editing.validateCreativePlan(creative(),words,4).visualStyle,undefined);
 assert.ok(editing.creativeSchema().properties.scenes);
});
test('v3 rejects invented scene figures, unsupported icons, colliding tracks and excessive sound',()=>{
 const p=referencePlan(),scene=p.scenes[0];
 for(const patch of [
  {scenes:[{...scene,title:'999 horas'}]},
  {scenes:[{...scene,items:[{label:'999',icon:'clock'},{label:'Otra',icon:'check'}]}]},
  {scenes:[{...scene,kind:'metric',items:[],value:999,unit:'horas'}]},
  {scenes:[{...scene,items:[{label:'Una',icon:'evil'},{label:'Otra',icon:'check'}]}]},
  {scenes:[scene,scene]}, {brolls:[{...p.brolls[0],start:2,duration:1,quote:'segundos'}]}, {overlays:creative().overlays},
  {soundCues:[{word:3,kind:'impact',gain:18}]}, {soundCues:[p.soundCues[0],p.soundCues[0]]}, {framing:{focusX:2,focusY:.4}},
  {scenes:[{...scene,endWord:3}]}, {visualStyle:'unknown'}
 ]) assert.throws(()=>editing.validateCreativePlan({...p,...patch},words,4));
});
test('reference scenes accept grounded metrics and all bounded diagram kinds',()=>{
 const p=referencePlan(),scene=p.scenes[0];
 for(const kind of ['distribution','comparison','sequence'])assert.equal(editing.validateCreativePlan({...p,scenes:[{...scene,kind}]},words,4).scenes[0].kind,kind);
 const metric={...scene,kind:'metric',items:[],value:3,unit:'segundos'};
 assert.equal(editing.validateCreativePlan({...p,scenes:[metric]},words,4).scenes[0].value,3);
 for(const patch of [{items:[]},{items:Array.from({length:8},()=>({label:'Idea',icon:'clip'}))},{kicker:'a'.repeat(33)},{title:'a'.repeat(49)},{evidenceStartWord:99},{value:3},{unit:'horas'},{src:'https://example.com'}])assert.throws(()=>editing.validateCreativePlan({...p,scenes:[{...scene,...patch}]},words,4));
});
test('visual review validation rejects malformed or unsupported output fields',()=>{
 assert.deepEqual(editing.validateVisualReview({ok:true,issues:[],summary:'Sin defectos visibles en los cuadros revisados.'}),{ok:true,issues:[],summary:'Sin defectos visibles en los cuadros revisados.'});
 for(const result of [{ok:false,issues:[],summary:'No'}, {ok:'true',issues:[],summary:'Sí'}, {ok:true,issues:[],summary:'Sí',html:'evil'}, {ok:false,issues:['x'.repeat(601)],summary:'No'}, {ok:false,issues:Array(21).fill('Error'),summary:'No'}])assert.throws(()=>editing.validateVisualReview(result));
});
test('scene item emphasis is generated explicitly while older plans remain unchanged',()=>{
 const old=referencePlan();
 assert.deepEqual(editing.validateCreativePlan(old,words,4).scenes,old.scenes);
 assert.equal(editing.validateCreativePlan(creative(),words,4).visualStyle,undefined);
 const schema=editing.creativeSchema().properties.scenes.items.properties.items.items;
 assert.ok(schema.required.includes('emphasis'));
 assert.deepEqual(schema.properties.emphasis.enum,['subdued','normal','prominent']);
 for(const emphasis of ['subdued','normal','prominent']){
  const p=referencePlan();p.scenes[0].items[0].emphasis=emphasis;
  assert.equal(editing.validateCreativePlan(p,words,4).scenes[0].items[0].emphasis,emphasis);
 }
});
test('scene item emphasis rejects unsupported values and capabilities',()=>{
 for(const emphasis of ['huge','',null,3,{},undefined]){
  const p=referencePlan();p.scenes[0].items[0].emphasis=emphasis;
  assert.throws(()=>editing.validateCreativePlan(p,words,4),/énfasis/i);
 }
 const p=referencePlan();p.scenes[0].items[0].css='opacity:0';
 assert.throws(()=>editing.validateCreativePlan(p,words,4),/campos/);
});
