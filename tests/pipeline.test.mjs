import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {processJob,WORKFLOW_VERSION,planFingerprint} from '../src/pipeline.mjs';
import {mediaDigest} from '../src/visual-context.mjs';
const contextFixture={images:['ref.jpg','source.jpg'],reference:{sha256:'a'.repeat(64),imageCount:1},source:{}};
const visualFixtures={digest:async()=> 'b'.repeat(64),prepare:async()=>contextFixture,reviewFrames:async()=>({images:['render.jpg'],sha256:'b'.repeat(64),samples:[1]})};
const criticFixture={reviewVisual:async()=>({ok:true,issues:[],summary:'Verified fixture',model:'gpt-6-astra',effort:'high'})};

test('confirmed rendering resumes at upload and only completes after Drive confirmation',async()=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'kavion-job-'));const final=path.join(dataDir,'final.mp4');await writeFile(final,'fixture');
 let job={id:'id1',sourceUrl:'https://drive.google.com/file/d/abcde12345/view',status:'running',artifacts:{workflowVersion:WORKFLOW_VERSION,render:{path:final},verification:{ok:true},visualContext:contextFixture}};
 const store={getJob:()=>job,getSettings:()=>({destinationFolderId:'folder',maxCreditsPerVideo:30}),updateJob:(id,p)=>{job={...job,...p,artifacts:{...job.artifacts,...p.artifacts}};return job;},addEvent:()=>{}};
 let uploads=0;const drive={upload:async()=>{uploads++;throw new Error('Drive no disponible');}};
 await processJob(job,{store,config:{dataDir},drive,media:{verifyVideo:async()=>({ok:true})},visuals:visualFixtures,editorial:criticFixture});assert.equal(job.status,'failed');assert.equal(uploads,1);
 drive.upload=async()=>({fileId:'remote',url:'https://drive.google.com/file/d/remote/view',filename:'final.mp4'});
 await processJob(job,{store,config:{dataDir},drive,media:{verifyVideo:async()=>({ok:true})},visuals:visualFixtures,editorial:criticFixture});assert.equal(job.status,'completed');assert.equal(job.result.fileId,'remote');await rm(dataDir,{recursive:true});
});

test('missing provider configuration stops before any paid operation',async()=>{
 let job={id:'id2',artifacts:{}};let spent=false;
 const store={getJob:()=>job,getSettings:()=>({maxCreditsPerVideo:null}),updateJob:(_,p)=>job={...job,...p},addEvent:()=>{}};
 await processJob(job,{store,config:{dataDir:os.tmpdir()},higgs:{generate:()=>spent=true}});
 assert.equal(job.status,'needs_configuration');assert.equal(spent,false);
});

test('lost worker ownership cannot update a replacement job or submit work',async()=>{
 let updated=false,spent=false;const job={id:'lost',artifacts:{},sourceUrl:'https://drive.google.com/file/d/abcdefghijk/view'};
 await processJob(job,{config:{dataDir:os.tmpdir()},store:{getJob:()=>job,getSettings:()=>({maxCreditsPerVideo:10}),updateJob:()=>updated=true,addEvent:()=>{}},assertLease:()=>{throw new Error('Lost ownership');},higgs:{generate:()=>spent=true}});
 assert.equal(updated,false);assert.equal(spent,false);
});

test('full staged pipeline only publishes after verified output and forwards timing expectations',async()=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'kavion-complete-'));let job={id:'complete',sourceUrl:'https://drive.google.com/file/d/abcdefghijk/view',artifacts:{}};let generated=0;let verified=false;
 const words=[{text:'Computadora',start:0.1,end:3.9}];
 const store={getJob:()=>job,getSettings:()=>({maxCreditsPerVideo:10,maxBrolls:2,destinationFolderId:'folder'}),addEvent:()=>{},updateJob:(_,p)=>job={...job,...p,artifacts:{...job.artifacts,...p.artifacts}}};
 let reviewed=false;
 const plan={schemaVersion:3,visualStyle:'kavion-clavicular-v1',provider:'codex',model:'gpt-6-astra',effort:'high',brolls:[{start:1,duration:3,prompt:'computer',quote:'Computadora'}],captionGroups:[{startWord:0,endWord:0,emphasis:[0],position:'lower'}],zooms:[],overlays:[]};
 const media={probe:async()=>({duration:4,width:360,height:640,hasAudio:true}),cutVideo:async(_,kept,_dir,_config,options)=>{assert.equal(reviewed,true);assert.deepEqual(options.originalWords,words);assert.deepEqual(kept,words);return {path:'cut.mp4',duration:4,words};},renderVideo:async input=>{assert.equal(input.plan.model,'gpt-6-astra');return path.join(dataDir,'final.mp4');},verifyVideo:async(_,c)=>{assert.equal(c.expectedDuration,4);assert.equal(c.expectedWordEnd,3.9);assert.equal(c.expectedWidth,360);verified=true;return {ok:true};}};
 await processJob(job,{store,config:{dataDir},media,visuals:visualFixtures,drive:{download:async(_,p)=>({path:p,name:'raw.mp4'}),upload:async()=>{assert.equal(verified,true);return {fileId:'remote',url:'https://drive.google.com/file/d/remote/view'};}},editorial:{...criticFixture,transcribe:async()=>words,review:async()=>{reviewed=true;return {words,cuts:[],provider:'codex',model:'gpt-6-astra',effort:'high'};},plan:async()=>plan},higgs:{check:async()=>({credits:100}),cost:async()=>4.5,generate:async(_,{checkpoint})=>{generated++;await checkpoint({jobId:'remote-job',estimatedCredits:4.5});return {url:'https://example.cloudfront.net/video.mp4'};}},downloadBroll:async(_,p)=>writeFile(p,'fixture')});
 assert.equal(job.status,'completed');assert.equal(generated,1);assert.equal(job.artifacts.generations[0].jobId,'remote-job');await rm(dataDir,{recursive:true});
});

test('a paid legacy plan is never relabeled as Astra or regenerated',async()=>{
 let job={id:'legacy',artifacts:{plan:{brolls:[{prompt:'old'}]},generations:{0:{jobId:'paid'}}}},spent=false;
 const store={getJob:()=>job,getSettings:()=>({maxCreditsPerVideo:15}),updateJob:(_,patch)=>job={...job,...patch},addEvent:()=>{}};
 await processJob(job,{store,config:{dataDir:os.tmpdir()},higgs:{generate:async()=>{spent=true;}}});
 assert.equal(job.status,'needs_attention');assert.match(job.error,/anterior|Astra/i);assert.equal(spent,false);
});

test('changing a frozen creative plan stops before touching paid assets',async()=>{
 let job={id:'changed',artifacts:{workflowVersion:WORKFLOW_VERSION,plan:{schemaVersion:3,visualStyle:'kavion-clavicular-v1',provider:'codex',model:'gpt-6-astra',effort:'high',brolls:[{prompt:'changed'}]},planFingerprint:'original-fingerprint',generations:{0:{jobId:'paid'}}}},touched=false;
 const store={getJob:()=>job,getSettings:()=>({maxCreditsPerVideo:15}),updateJob:(_,patch)=>job={...job,...patch},addEvent:()=>{}};
 await processJob(job,{store,config:{dataDir:os.tmpdir()},preflight:async()=>{touched=true;return [];}});
 assert.equal(job.status,'needs_attention');assert.match(job.error,/plan/i);assert.equal(touched,false);
});

for(const code of ['LOCAL_RESOURCES_WAIT','MODAL_TRANSCRIPTION_RUNNING','MODAL_TRANSCRIPTION_BUSY','MODAL_MEDIA_RUNNING','MODAL_MEDIA_BUSY'])test(`transient ${code} retains completed checkpoints and retries later`,async()=>{
 let job={id:'waiting',artifacts:{workflowVersion:WORKFLOW_VERSION,transcript:[{text:'Hola',start:0,end:1}]}},events=[];
 const store={getJob:()=>job,getSettings:()=>({maxCreditsPerVideo:15}),updateJob:(_,patch)=>job={...job,...patch},addEvent:(_,event)=>events.push(event)};
 const started=Date.now();
 await processJob(job,{store,config:{dataDir:os.tmpdir()},preflight:async()=>{throw Object.assign(new Error('Esperando memoria'),{code});}});
 assert.equal(job.status,'queued');assert.ok(job.retryAfter>=started+60000);assert.equal(job.artifacts.transcript[0].text,'Hola');assert.match(events[0].message,/memoria/);
});

test('a paid legacy render cannot bypass the migration review on retry',async()=>{
 let job={id:'legacy-render',artifacts:{plan:{provider:'deepseek',brolls:[{}]},generations:{0:{jobId:'paid'}},render:{path:'old-final.mp4'},verification:{ok:true}}},uploaded=false;
 const store={getJob:()=>job,getSettings:()=>({maxCreditsPerVideo:15}),updateJob:(_,patch)=>job={...job,...patch},addEvent:()=>{}};
 await processJob(job,{store,config:{dataDir:os.tmpdir()},drive:{upload:async()=>{uploaded=true;return {fileId:'old',url:'https://example.com'};}}});
 assert.equal(job.status,'needs_attention');assert.equal(uploaded,false);
});

test('unsubmitted legacy decisions are discarded before a fresh Astra workflow',async()=>{
 let job={id:'unsubmitted',artifacts:{source:{path:'source.mp4'},plan:{provider:'deepseek',brolls:[{}]},transcript:[{}]}};
 const store={getJob:()=>job,getSettings:()=>({maxCreditsPerVideo:15}),updateJob:(_,patch)=>job={...job,...patch,artifacts:{...job.artifacts,...patch.artifacts}},addEvent:()=>{}};
 await processJob(job,{store,config:{dataDir:os.tmpdir()},preflight:async()=>['Falta preparar el equipo']});
 assert.equal(job.status,'needs_configuration');assert.equal(job.artifacts.workflowVersion,WORKFLOW_VERSION);assert.equal(job.artifacts.plan,null);assert.equal(job.artifacts.transcript,null);assert.equal(job.artifacts.source.path,'source.mp4');
});

test('a failed visual critique blocks delivery despite technical success',async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'kavion-visual-gate-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));let uploaded=false;
 let job={id:'visual-failed',sourceUrl:'https://drive.google.com/file/d/abcdefghijk/view',artifacts:{workflowVersion:WORKFLOW_VERSION,render:{path:'final.mp4'},verification:{ok:true},cut:{words:[],duration:3},sourceInfo:{width:1080,height:1920},visualContext:{images:['reference.jpg'],reference:{sha256:'a'.repeat(64),imageCount:1}}}};
 const store={getJob:()=>job,getSettings:()=>({maxCreditsPerVideo:15}),updateJob:(_,p)=>job={...job,...p,artifacts:{...job.artifacts,...p.artifacts}},addEvent:()=>{}};
 await processJob(job,{store,config:{dataDir},drive:{upload:async()=>{uploaded=true;}},media:{verifyVideo:async()=>({ok:true})},visuals:{digest:async()=> 'b'.repeat(64),reviewFrames:async()=>({images:['render.jpg'],sha256:'b'.repeat(64),samples:[1]})},editorial:{reviewVisual:async()=>({ok:false,issues:['El panel tapa el rostro.'],summary:'Corregir encuadre.',model:'gpt-6-astra',effort:'high'})}});
 assert.equal(uploaded,false);assert.equal(job.status,'needs_attention');assert.match(job.error,/rostro/);assert.equal(job.artifacts.visualReview.ok,false);
});


test('changed render bytes invalidate technical and visual approvals before a resumed upload',async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'kavion-changed-render-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const final=path.join(dataDir,'final.mp4'),voice=path.join(dataDir,'cut.mp4');
 await writeFile(final,'before');await writeFile(voice,'unchanged original voice');
 const plan={schemaVersion:3,visualStyle:'kavion-clavicular-v1',provider:'codex',model:'gpt-6-astra',effort:'high'};
 let job={id:'changed-render',status:'running',artifacts:{workflowVersion:WORKFLOW_VERSION,render:{path:final},cut:{path:voice,duration:3,words:[{text:'Hola',start:0,end:2.9}]},sourceInfo:{width:1080,height:1920},plan,planFingerprint:planFingerprint(plan),visualContext:contextFixture}};
 const store={getJob:()=>job,getSettings:()=>({destinationFolderId:'folder',maxCreditsPerVideo:30}),updateJob:(_,patch)=>job={...job,...patch,artifacts:{...job.artifacts,...patch.artifacts}},addEvent:()=>{}};
 const calls=[];let technicalBytes,visualBytes,uploads=0;
 const dependencies={store,config:{dataDir},
  // Use actual file digests; only external verification, critique, and upload are replaced.
  visuals:{reviewFrames:async file=>({images:[file],sha256:await mediaDigest(file),samples:[1]})},
  media:{verifyVideo:async(file,config)=>{
   calls.push('verify');assert.equal(config.voiceReferencePath,voice);assert.equal(config.expectedDuration,3);
   technicalBytes=await readFile(file,'utf8');return {ok:true,issues:[],checkedBytes:technicalBytes};
  }},
  editorial:{reviewVisual:async({images})=>{
   calls.push('critique');visualBytes=await readFile(images.at(-1),'utf8');
   return {ok:true,issues:[],summary:'Checked '+visualBytes,model:'gpt-6-astra',effort:'high'};
  }},
  drive:{upload:async file=>{
   calls.push('upload');const bytes=await readFile(file,'utf8');
   assert.equal(technicalBytes,bytes,'upload must use technical approval for the current bytes');
   assert.equal(visualBytes,bytes,'upload must use visual approval for the current bytes');
   if(++uploads<3)throw new Error('Drive temporarily unavailable');
   return {fileId:'confirmed',url:'https://drive.google.com/file/d/confirmed/view'};
  }}
 };
 await processJob(job,dependencies);
 assert.equal(job.status,'failed');assert.deepEqual(calls,['verify','critique','upload']);
 const initialVerification=job.artifacts.verificationFingerprint,initialReview=job.artifacts.visualReview.renderSha256;
 calls.length=0;
 await processJob(job,dependencies);
 assert.equal(job.status,'failed');assert.deepEqual(calls,['upload'],'unchanged bytes retain both approvals across a retry');
 // Same filename and length: only the byte identity changes.
 await writeFile(final,'after!');calls.length=0;
 await processJob(job,dependencies);
 assert.equal(job.status,'completed');assert.deepEqual(calls,['verify','critique','upload']);
 assert.equal(job.artifacts.verification.checkedBytes,'after!');
 assert.notEqual(job.artifacts.verificationFingerprint,initialVerification);
 assert.notEqual(job.artifacts.visualReview.renderSha256,initialReview);
 assert.equal(job.artifacts.plan,plan);
});

test('an uploaded original skips Drive download and completes through the same verified delivery',async()=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'kavion-upload-pipeline-'));
 const source=path.join(dataDir,'original.mov');await writeFile(source,'original');
 let job={id:'uploaded',sourceType:'upload',sourceUrl:null,sourceName:'Cámara.MOV',artifacts:{source:{path:source,name:'Cámara.MOV',type:'upload'}}};
 const words=[{text:'Hola',start:.1,end:.8}],calls=[];
 const store={getJob:()=>job,getSettings:()=>({maxCreditsPerVideo:15,maxBrolls:2,destinationFolderId:'destination'}),addEvent:()=>{},updateJob:(_,p)=>job={...job,...p,artifacts:{...job.artifacts,...p.artifacts}}};
 const plan={schemaVersion:3,visualStyle:'kavion-clavicular-v1',provider:'codex',model:'gpt-6-astra',effort:'high',brolls:[],captionGroups:[{startWord:0,endWord:0}],zooms:[],overlays:[]};
 try{
  await processJob(job,{store,config:{dataDir},visuals:visualFixtures,
   drive:{download:async()=>{throw new Error('Uploaded source must not be downloaded');},upload:async(_,opts)=>{calls.push('upload');assert.equal(opts.folderId,'destination');assert.equal(opts.name,'Cámara-editado-uploaded.mp4');return {fileId:'final',url:'https://drive.google.com/file/d/final/view'};}},
   editorial:{...criticFixture,transcribe:async file=>{assert.equal(file,source);calls.push('transcribe');return words;},review:async()=>({words}),plan:async()=>plan},
   media:{probe:async()=>({duration:1,width:1080,height:1920,hasAudio:true}),cutVideo:async()=>({path:source,duration:1,words}),renderVideo:async()=>{calls.push('render');return source;},verifyVideo:async()=>{calls.push('verify');return {ok:true,issues:[]};}},
   higgs:{check:async()=>({credits:100})}});
  assert.equal(job.status,'completed');assert.deepEqual(calls,['transcribe','render','verify','upload']);assert.equal(job.artifacts.source.path,source);
 }finally{await rm(dataDir,{recursive:true,force:true});}
});

async function recoveryFixture(t,{technicalFailures=1,visualFailures=0}={}){
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'kavion-recovery-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const root=path.join(dataDir,'jobs','recover');await (await import('node:fs/promises')).mkdir(root,{recursive:true});
 const source=path.join(root,'source.mp4'),cut=path.join(root,'cut.mp4'),render=path.join(root,'final.mp4');for(const file of [source,cut,render])await writeFile(file,file);
 const words=[{text:'Hola',start:0,end:1},{text:'mundo',start:3,end:4}];
 const clip={start:2,duration:1,prompt:'A realistic notebook on a wooden desk',quote:'mundo'};
 const plan={schemaVersion:3,visualStyle:'kavion-clavicular-v1',provider:'codex',model:'gpt-6-astra',effort:'high',brolls:[clip],captionGroups:[],zooms:[],overlays:[]};
 let job={id:'recover',status:'running',sourceName:'original.mp4',artifacts:{workflowVersion:WORKFLOW_VERSION,source:{path:source},transcript:words,review:{words,cuts:[]},cut:{path:cut,duration:4,words,segments:[{start:0,end:4,outputStart:0}]},plan,planFingerprint:planFingerprint(plan),brolls:[{path:'paid.mp4',start:2,duration:1}],generations:{0:{jobId:'paid',downloaded:true}},render:{path:render},sourceInfo:{width:360,height:640},visualContext:contextFixture}};
 const store={getJob:()=>job,getSettings:()=>({maxCreditsPerVideo:10,maxBrolls:2,destinationFolderId:'folder'}),updateJob:(_,p)=>job={...job,...p,artifacts:{...job.artifacts,...p.artifacts}},addEvent:()=>{}};
 const calls=[];let verifies=0,critiques=0;
 const deps={store,config:{dataDir},visuals:{...visualFixtures,digest:async file=>file,prepare:async()=>contextFixture,reviewFrames:async file=>({images:[file],sha256:file,samples:[1]})},media:{frames:async(_source,times,dir)=>({images:[path.join(dir,'sheet.jpg')]}),cutVideo:async(s,w,dir)=>{calls.push(['cut',dir]);assert.ok(job.artifacts.recovery.pending);return {path:path.join(dir,'cut.mp4'),duration:3,words:[words[0],{...words[1],start:2,end:3}],segments:[{start:0,end:1,outputStart:0},{start:2,end:4,outputStart:1}]};},renderVideo:async input=>{calls.push(['render',input.dir]);assert.equal(input.brolls[0].path,'paid.mp4');return path.join(input.dir,'final.mp4');},verifyVideo:async()=>++verifies<=technicalFailures?{ok:false,issues:['Silencio medido de 0.4 s: supera el máximo de 0.3 s.']}:{ok:true,issues:[]}},editorial:{repairBrollPlan:async()=>({repairs:[]}),plan:async(w,d,n,dir,context)=>{calls.push(['plan',dir,context]);assert.ok(job.artifacts.recovery.pending);return {...plan,brolls:context.lockedBrolls};},reviewVisual:async()=>++critiques<=visualFailures?{ok:false,issues:['El panel tapa el rostro.'],summary:'Corregir encuadre.',model:'gpt-6-astra',effort:'high'}:{ok:true,issues:[],summary:'Correcto.',model:'gpt-6-astra',effort:'high'}},drive:{upload:async()=>{calls.push(['upload']);return {fileId:'remote',url:'https://drive.google.com/file/d/remote/view'};}}};
 return {deps,calls,get job(){return job;},get verifies(){return verifies;}};
}

test('cached silence rejection repairs and delivers using the existing paid generations',async t=>{
 const f=await recoveryFixture(t,{technicalFailures:0});
 const a=f.job.artifacts;
 f.deps.store.updateJob(f.job.id,{artifacts:{verification:{ok:false,issues:['Silencio medido de 0.4 s: supera el máximo de 0.3 s.']},verificationFingerprint:planFingerprint({render:a.render.path,voice:a.cut.path,duration:a.cut.duration,width:360,height:640,wordEnd:4,maxSilence:.3})}});
 await processJob(f.job,f.deps);
 assert.equal(f.verifies,1,'cached rejected output is repaired before verifying new bytes');
 assert.equal(f.job.status,'completed');assert.equal(f.job.artifacts.generations[0].jobId,'paid');
 assert.equal(f.calls.filter(c=>c[0]==='cut').length,1);assert.equal(f.job.artifacts.plan.brolls[0].start,1);
 assert.match(f.job.artifacts.render.path,/recovery\/technical-1/);assert.equal(f.job.artifacts.recovery.history.length,1);
});

test('interrupted recovery resumes the saved cut and revision directory',async t=>{
 const f=await recoveryFixture(t);let first=true;const render=f.deps.media.renderVideo;
 f.deps.media.renderVideo=async input=>{if(first){first=false;throw new Error('interrupted render');}return render(input);};
 await processJob(f.job,f.deps);assert.equal(f.job.status,'failed');assert.ok(f.job.artifacts.recovery.pending.cut);
 const revision=f.job.artifacts.recovery.pending.dir;await processJob(f.job,f.deps);
 assert.equal(f.job.status,'completed');assert.equal(f.calls.filter(c=>c[0]==='cut').length,1);assert.equal(f.calls.find(c=>c[0]==='render')[1],revision);
});

test('silence recovery stops after two revisions without uploading rejected output',async t=>{
 const f=await recoveryFixture(t,{technicalFailures:99});await processJob(f.job,f.deps);
 assert.equal(f.job.status,'failed');assert.match(f.job.error,/agot|autom.tic/i);assert.equal(f.calls.filter(c=>c[0]==='cut').length,2);assert.equal(f.calls.some(c=>c[0]==='upload'),false);
});

test('visual rejection revises the plan with concrete feedback and checks the new render',async t=>{
 const f=await recoveryFixture(t,{technicalFailures:0,visualFailures:1});await processJob(f.job,f.deps);
 assert.equal(f.job.status,'completed');const planning=f.calls.find(c=>c[0]==='plan');assert.match(planning[1],/recovery\/visual-1/);assert.deepEqual(planning[2].repairFeedback.issues,['El panel tapa el rostro.']);assert.equal(f.verifies,2);assert.equal(f.calls.filter(c=>c[0]==='cut').length,0);
});

test('unrelated technical verification failures still block automatic delivery',async t=>{
 const f=await recoveryFixture(t);f.deps.media.verifyVideo=async()=>({ok:false,issues:['Las dimensiones no coinciden.']});await processJob(f.job,f.deps);
 assert.equal(f.job.status,'needs_attention');assert.equal(f.calls.length,0);
});


test('visual recovery exhausts its bounded revisions without approving or uploading',async t=>{
 const f=await recoveryFixture(t,{technicalFailures:0,visualFailures:99});await processJob(f.job,f.deps);
 assert.equal(f.job.status,'failed');assert.match(f.job.error,/agot.*autom.tic/i);assert.equal(f.calls.filter(c=>c[0]==='plan').length,2);assert.equal(f.job.artifacts.visualReview.ok,false);assert.equal(f.calls.some(c=>c[0]==='upload'),false);
});

test('remote work still running queues and resumes the same recovery attempt',async t=>{
 const f=await recoveryFixture(t);const cut=f.deps.media.cutVideo;let submitted=false,revision;
 f.deps.media.cutVideo=async(...args)=>{if(!submitted){submitted=true;revision=args[2];throw Object.assign(new Error('El recorte sigue procesando.'),{code:'MODAL_MEDIA_RUNNING'});}assert.equal(args[2],revision);return cut(...args);};
 await processJob(f.job,f.deps);assert.equal(f.job.status,'queued');assert.ok(f.job.retryAfter>Date.now());assert.equal(f.job.artifacts.recovery.technicalAttempts,1);
 await processJob(f.job,f.deps);assert.equal(f.job.status,'completed');assert.equal(f.job.artifacts.recovery.technicalAttempts,1);
});

test('visual repair includes the rejected plan and frames alongside the reference',async t=>{
 const f=await recoveryFixture(t,{technicalFailures:0,visualFailures:1});const previous=f.job.artifacts.plan,previousRender=f.job.artifacts.render.path;
 await processJob(f.job,f.deps);const context=f.calls.find(c=>c[0]==='plan')[2];
 assert.deepEqual(context.repairFeedback.previousPlan,previous);assert.ok(context.images.includes(previousRender));assert.ok(context.images.includes('ref.jpg'));assert.ok(context.images.length<=8);
});

test('an external upload checkpoint blocks content revision and preserves its identity',async t=>{
 const f=await recoveryFixture(t);const upload={sessionUrl:'https://upload.example/session',offset:123};f.deps.store.updateJob(f.job.id,{artifacts:{upload}});
 await processJob(f.job,f.deps);assert.equal(f.job.status,'needs_attention');assert.match(f.job.error,/subida|upload/i);assert.deepEqual(f.job.artifacts.upload,upload);assert.equal(f.calls.length,0);
});

test('quality recovery preserves the original reference before changing the plan',async t=>{
 const f=await recoveryFixture(t);f.deps.visuals.prepare=async()=>({...contextFixture,reference:{...contextFixture.reference,sha256:'changed'}});
 await processJob(f.job,f.deps);assert.equal(f.job.status,'needs_attention');assert.match(f.job.error,/referencia.*cambi/i);assert.equal(f.calls.some(c=>c[0]==='plan'),false);
});

test('recovery validates the frozen B-roll data before trusting a planner',async t=>{
 const f=await recoveryFixture(t);const plan={...f.job.artifacts.plan,brolls:f.job.artifacts.plan.brolls.map(c=>({...c,prompt:'x'}))};f.deps.store.updateJob(f.job.id,{artifacts:{plan,planFingerprint:planFingerprint(plan)}});
 await processJob(f.job,f.deps);assert.notEqual(f.job.status,'completed');assert.equal(f.calls.some(c=>c[0]==='plan'),false);assert.equal(f.calls.some(c=>c[0]==='render'),false);
});

test('technical recovery reschedules overlapping mapped B-rolls without changing purchased assets',async t=>{
 const f=await recoveryFixture(t);const a=f.job.artifacts;
 const words=[{text:'Hola',start:0,end:1},{text:'mundo',start:4,end:5},{text:'otra',start:7,end:8}];
 const clips=[{start:1,duration:3,prompt:'A realistic notebook on a wooden desk',quote:'Hola'},{start:4,duration:3,prompt:'A realistic computer monitor showing colorful footage',quote:'mundo'}];
 const plan={...a.plan,brolls:clips};
 f.deps.store.updateJob(f.job.id,{artifacts:{transcript:words,review:{words,cuts:[]},cut:{...a.cut,duration:10,words,segments:[{start:0,end:10,outputStart:0}]},plan,planFingerprint:planFingerprint(plan),brolls:[{path:'paid.mp4',start:1,duration:3},{path:'paid-second.mp4',start:4,duration:3}],generations:{0:{jobId:'paid',downloaded:true},1:{jobId:'paid-second',downloaded:true}}}});
 f.deps.media.cutVideo=async(_source,_words,dir)=>({path:path.join(dir,'cut.mp4'),duration:9,words:[words[0],{...words[1],start:3,end:4},{...words[2],start:6,end:7}],segments:[{start:0,end:2,outputStart:0},{start:3,end:10,outputStart:2}]});
 let rendered;
 f.deps.media.renderVideo=async input=>{rendered=input;return path.join(input.dir,'final.mp4');};
 await processJob(f.job,f.deps);
 assert.equal(f.job.status,'completed');assert.deepEqual(f.job.artifacts.plan.brolls,clips);
 assert.deepEqual(rendered.brolls,[{path:'paid.mp4',start:1,duration:3},{path:'paid-second.mp4',start:4,duration:3}]);
 assert.equal(f.job.artifacts.generations[1].jobId,'paid-second');
});

test('visual asset repair renders treated copies while preserving paid assets and word timings',async t=>{
 const f=await recoveryFixture(t,{technicalFailures:0,visualFailures:1});const before=structuredClone(f.job.artifacts);const regions=[{x:.1,y:.2,width:.5,height:.4}];let treatments=0,proposalInputs,rendered;
 f.deps.editorial.repairBrollPlan=async input=>{proposalInputs=input;assert.ok(f.job.artifacts.recovery.pending.brollInspections[0]);return {repairs:[{index:0,regions}]};};
 f.deps.media.repairBrollVideo=async(source,rectangles,dir)=>{treatments++;assert.equal(source,'paid.mp4');assert.deepEqual(rectangles,regions);assert.ok(f.job.artifacts.recovery.pending.brollRepairProposal);return {path:path.join(dir,'repaired.mp4'),regions:rectangles};};
 f.deps.media.renderVideo=async input=>{rendered=input;return path.join(input.dir,'final.mp4');};
 await processJob(f.job,f.deps);
 assert.equal(f.job.status,'completed');assert.equal(treatments,1);assert.match(rendered.brolls[0].path,/broll-repair-0\/repaired.mp4/);assert.deepEqual(rendered.words,before.cut.words);assert.deepEqual(f.job.artifacts.generations,before.generations);
 assert.deepEqual(f.job.artifacts.recovery.history[0].previousBrolls,before.brolls);assert.deepEqual(f.job.artifacts.plan.brolls,before.plan.brolls);assert.equal(proposalInputs.images.length,1);assert.deepEqual(proposalInputs.issues,['El panel tapa el rostro.']);
 const context=f.calls.find(c=>c[0]==='plan')[2];assert.ok(context.repairFeedback.brollRepairs);assert.equal(f.job.artifacts.recovery.history[0].brollRepairs[0].source,'paid.mp4');
});

test('remote B-roll treatment resumes its saved proposal and completed assets',async t=>{
 const f=await recoveryFixture(t,{technicalFailures:0,visualFailures:1});let proposals=0,frames=0,submissions=0,dir;
 f.deps.media.frames=async(_source,_times,output)=>{frames++;return {images:[path.join(output,'sheet.jpg')]};};
 f.deps.editorial.repairBrollPlan=async()=>{proposals++;return {repairs:[{index:0,regions:[{x:0,y:0,width:.5,height:.5}]}]};};
 f.deps.media.repairBrollVideo=async(_source,regions,output)=>{if(!submissions++){dir=output;throw Object.assign(new Error('Modal sigue procesando.'),{code:'MODAL_MEDIA_RUNNING'});}assert.equal(output,dir);return {path:path.join(output,'repaired.mp4'),regions};};
 f.deps.media.renderVideo=async input=>path.join(input.dir,'final.mp4');
 await processJob(f.job,f.deps);assert.equal(f.job.status,'queued');assert.ok(f.job.artifacts.recovery.pending.brollRepairProposal);assert.equal(f.calls.some(c=>c[0]==='plan'),false);
 await processJob(f.job,f.deps);assert.equal(f.job.status,'completed');assert.equal(proposals,1);assert.equal(frames,1);assert.equal(f.job.artifacts.recovery.visualAttempts,1);
});

test('a queued second B-roll treatment retains the first treated asset',async t=>{
 const f=await recoveryFixture(t,{technicalFailures:0,visualFailures:1});const a=f.job.artifacts;
 const clips=[{...a.plan.brolls[0],start:0,duration:1,quote:'Hola'},{...a.plan.brolls[0],start:2,duration:1}];const plan={...a.plan,brolls:clips};
 f.deps.store.updateJob(f.job.id,{artifacts:{plan,planFingerprint:planFingerprint(plan),brolls:[{path:'paid.mp4',start:0,duration:1},{path:'paid-second.mp4',start:2,duration:1}],generations:{0:{jobId:'paid'},1:{jobId:'paid-second'}}}});
 const treatments=[];let waiting=true;
 f.deps.editorial.repairBrollPlan=async()=>({repairs:clips.map((_,index)=>({index,regions:[{x:0,y:0,width:.5,height:.5}]}))});
 f.deps.media.repairBrollVideo=async(source,regions,dir)=>{treatments.push(source);if(source==='paid-second.mp4'&&waiting){waiting=false;throw Object.assign(new Error('Modal sigue procesando.'),{code:'MODAL_MEDIA_RUNNING'});}return {path:path.join(dir,'repaired.mp4'),regions};};
 f.deps.media.renderVideo=async input=>path.join(input.dir,'final.mp4');
 await processJob(f.job,f.deps);assert.equal(f.job.status,'queued');assert.ok(f.job.artifacts.recovery.pending.brollRepairResults[0]);
 await processJob(f.job,f.deps);assert.equal(f.job.status,'completed');assert.deepEqual(treatments,['paid.mp4','paid-second.mp4','paid-second.mp4']);
});

test('B-roll treatment refreshes an earlier pending planning context before inference',async t=>{
 const f=await recoveryFixture(t,{technicalFailures:0,visualFailures:0});let cutDone=false;
 const originalPrepare=f.deps.visuals.prepare;
 f.deps.visuals.prepare=async(...args)=>{cutDone=true;return originalPrepare(...args);};
 f.deps.editorial.repairBrollPlan=async()=>({repairs:[{index:0,regions:[{x:0,y:0,width:.5,height:.5}]}]});
 f.deps.media.repairBrollVideo=async(_source,regions,dir)=>({path:path.join(dir,'repaired.mp4'),regions});
 f.deps.media.renderVideo=async input=>path.join(input.dir,'final.mp4');
 const a=f.job.artifacts;
 f.deps.store.updateJob(f.job.id,{artifacts:{recovery:{visualAttempts:1,history:[],pending:{kind:'visual',number:1,dir:path.join(f.deps.config.dataDir,'jobs','recover','recovery','visual-1'),baseCut:a.cut,cut:a.cut,basePlan:a.plan,baseBrolls:a.brolls,baseVisualContext:a.visualContext,feedback:{issues:['Interfaz inventada.']},visualContext:{...contextFixture,lockedBrolls:a.plan.brolls,repairFeedback:{issues:['Interfaz inventada.']}}}}}});
 await processJob(f.job,f.deps);assert.equal(f.job.status,'completed');assert.equal(cutDone,true);assert.ok(f.calls.find(c=>c[0]==='plan')[2].repairFeedback.brollRepairs?.length);
});

test('successive visual revisions cannot cumulatively blur away a paid asset',async t=>{
 const f=await recoveryFixture(t,{technicalFailures:0,visualFailures:2});const generations=structuredClone(f.job.artifacts.generations);let proposals=0,treatments=0,renders=0;const prior={x:0,y:0,width:.6,height:1};let secondInput;
 f.deps.editorial.repairBrollPlan=async input=>{if(proposals++)secondInput=input;return {repairs:[{index:0,regions:[proposals===1?prior:{x:.4,y:0,width:.6,height:1}]}]};};
 f.deps.media.repairBrollVideo=async(_source,regions,dir)=>{treatments++;return {path:path.join(dir,'repaired.mp4'),regions};};
 f.deps.media.renderVideo=async input=>{renders++;return path.join(input.dir,'final.mp4');};
 await processJob(f.job,f.deps);
 assert.equal(f.job.status,'failed');assert.match(f.job.error,/acumulad/i);assert.equal(treatments,1);assert.equal(renders,1);assert.equal(f.calls.some(c=>c[0]==='upload'),false);
 assert.deepEqual(secondInput.brolls[0].repairRegions,[prior]);assert.deepEqual(f.job.artifacts.brolls[0].repairRegions,[prior]);assert.deepEqual(f.job.artifacts.generations,generations);assert.equal(f.job.artifacts.recovery.history[0].previousBrolls[0].path,'paid.mp4');assert.deepEqual(f.job.artifacts.recovery.history[0].brollRepairs[0].repairRegions,[prior]);
});

test('visual inspection samples moving artifacts densely and renders timed masks',async t=>{
 const f=await recoveryFixture(t,{technicalFailures:0,visualFailures:1});let input,requestedTimes,treatedRegions;const region={x:.1,y:.2,width:.5,height:.3,start:.1,end:.8};
 f.deps.media.frames=async(_source,times,dir)=>{requestedTimes=times;return {images:[path.join(dir,'sheet-0.jpg'),path.join(dir,'sheet-1.jpg')]};};
 f.deps.editorial.repairBrollPlan=async value=>{input=value;return {repairs:[{index:0,regions:[region]}]};};
 f.deps.media.repairBrollVideo=async(_source,regions,dir)=>{treatedRegions=regions;return {path:path.join(dir,'repaired.mp4'),regions};};
 f.deps.media.renderVideo=async value=>path.join(value.dir,'final.mp4');
 await processJob(f.job,f.deps);assert.equal(f.job.status,'completed');assert.equal(requestedTimes.length,12);assert.equal(input.images.length,2);assert.deepEqual(input.samples[0].times,requestedTimes);assert.deepEqual(treatedRegions,[region]);assert.deepEqual(f.job.artifacts.brolls[0].repairRegions,[region]);
});

test('dense B-roll inspection stays within eight images for eight paid clips',async t=>{
 const f=await recoveryFixture(t,{technicalFailures:0,visualFailures:1});const a=f.job.artifacts;
 const words=Array.from({length:8},(_,i)=>({text:`palabra${i}`,start:i*1.5,end:i*1.5+1}));
 const clips=words.map((word,i)=>({start:word.start,duration:1,prompt:'A realistic computer screen showing an editing timeline',quote:word.text}));
 const plan={...a.plan,brolls:clips};
 f.deps.store.getSettings=()=>({maxCreditsPerVideo:10,maxBrolls:8,destinationFolderId:'folder'});
 f.deps.store.updateJob(f.job.id,{artifacts:{transcript:words,review:{words,cuts:[]},cut:{...a.cut,duration:12,words,segments:[{start:0,end:12,outputStart:0}]},plan,planFingerprint:planFingerprint(plan),brolls:clips.map((clip,i)=>({path:`paid-${i}.mp4`,start:clip.start,duration:clip.duration})),generations:Object.fromEntries(clips.map((_,i)=>[i,{jobId:`paid-${i}`}]))}});
 const sampleCounts=[];let proposalInput;
 f.deps.media.frames=async(_source,times,dir)=>{sampleCounts.push(times.length);return {images:[path.join(dir,'sheet.jpg')]};};
 f.deps.editorial.repairBrollPlan=async input=>{proposalInput=input;return {repairs:[]};};
 f.deps.media.renderVideo=async input=>path.join(input.dir,'final.mp4');
 await processJob(f.job,f.deps);assert.equal(f.job.status,'completed');assert.deepEqual(sampleCounts,Array(8).fill(6));assert.equal(proposalInput.images.length,8);assert.deepEqual(proposalInput.samples.map(sample=>sample.imageIndices),Array.from({length:8},(_,i)=>[i]));
});

test('visual recovery omits an unsuitable paid clip and keeps matching plan assets and voice',async t=>{
 const f=await recoveryFixture(t,{technicalFailures:0,visualFailures:1});const a=f.job.artifacts,words=structuredClone(a.cut.words);
 const clips=[{...a.plan.brolls[0],start:0,duration:1,quote:'Hola'},{...a.plan.brolls[0],start:2,duration:1}],plan={...a.plan,brolls:clips},generations={0:{jobId:'paid'},1:{jobId:'paid-second'}};
 f.deps.store.updateJob(f.job.id,{artifacts:{plan,planFingerprint:planFingerprint(plan),brolls:[{path:'paid.mp4',start:0,duration:1,repairRegions:[{x:0,y:0,width:.5,height:.5}]},{path:'paid-second.mp4',start:2,duration:1}],generations}});
 f.deps.editorial.repairBrollPlan=async()=>({repairs:[],omitIndices:[0]});let rendered;
 f.deps.media.renderVideo=async input=>{rendered=input;return path.join(input.dir,'final.mp4');};
 await processJob(f.job,f.deps);assert.equal(f.job.status,'completed');assert.deepEqual(rendered.plan.brolls,[clips[1]]);assert.deepEqual(rendered.brolls,[{path:'paid-second.mp4',start:2,duration:1}]);assert.deepEqual(rendered.words,words);assert.deepEqual(f.job.artifacts.generations,generations);
 const history=f.job.artifacts.recovery.history[0];assert.deepEqual(history.selectedBrollIndices,[1]);assert.equal(history.omittedBrolls[0].index,0);assert.equal(history.omittedBrolls[0].path,'paid.mp4');assert.equal(history.previousBrolls.length,2);assert.deepEqual(f.calls.find(c=>c[0]==='plan')[2].lockedBrolls,[clips[1]]);
});

test('the pipeline rejects omission of its last B-roll before planning or publishing',async t=>{
 const f=await recoveryFixture(t,{technicalFailures:0,visualFailures:1});f.deps.editorial.repairBrollPlan=async()=>({repairs:[],omitIndices:[0]});
 await processJob(f.job,f.deps);assert.equal(f.job.status,'failed');assert.match(f.job.error,/conservar.*clip|omisi.n/i);assert.equal(f.calls.some(c=>['plan','render','upload'].includes(c[0])),false);assert.equal(f.job.artifacts.generations[0].jobId,'paid');
});
