import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat,symlink,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {runMediaCommand} from '../src/media.mjs';
const module=await import('../src/modal-transcription.mjs').catch(()=>({}));
const words=[{text:'Hola',start:.1,end:.4},{text:'mundo.',start:.5,end:.9}];
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'modal-asr-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=join(dir,'source.mp4');await writeFile(source,'original-voice');
 const calls=[];
 const runImpl=async(binary,args,opts)=>{
  calls.push({binary,args,opts});
  if(args[1]==='check')return {stdout:JSON.stringify({ok:true})};
  const request=JSON.parse(await readFile(args[2],'utf8'));
  const result=JSON.stringify({fingerprint:request.fingerprint,words});
  await writeFile(join(request.stateDir,'result.json'),result,{mode:0o600});
  await writeFile(join(request.stateDir,'state.json'),JSON.stringify({fingerprint:request.fingerprint,phase:'complete',call_id:'fc-test',resultHash:createHash('sha256').update(result).digest('hex')}),{mode:0o600});
  return {stdout:JSON.stringify({ok:true})};
 };
 assert.equal(typeof module.ModalTranscriber,'function');
 const client=new module.ModalTranscriber({rootDir:process.cwd(),pythonPath:'modal-python',pythonLibs:'/private/python-libs',modalConfigPath:'/private/modal.toml'},{runImpl});
 return {dir,source,client,calls};
}
test('Modal ASR preserves deployed parameters and validates a source-keyed private cache',async t=>{
 const {dir,source,client,calls}=await fixture(t);
 const previous=process.env.HIGGSFIELD_API_KEY;process.env.HIGGSFIELD_API_KEY='test-only-service-secret';
 try{assert.deepEqual(await client.transcribe(source,dir),words);}finally{if(previous===undefined)delete process.env.HIGGSFIELD_API_KEY;else process.env.HIGGSFIELD_API_KEY=previous;}
 const request=JSON.parse(await readFile(calls[0].args[2],'utf8'));
 assert.deepEqual(request.settings,{app:'kavion-whisperx-real',function:'transcribe_file',filesystem:'kavion-whisperx-inputs',model:'large-v3',language:'es',diarization:false,environment:''});
 assert.equal(calls[0].opts.env.MODAL_CONFIG_PATH,'/private/modal.toml');
 assert.ok(!Object.hasOwn(calls[0].opts.env,'HIGGSFIELD_API_KEY'));
 assert.ok(!JSON.stringify(request).includes('modal.toml'));
 assert.deepEqual(await client.transcribe(source,dir),words);assert.equal(calls.length,1);
 await writeFile(source,'changed-voice');await client.transcribe(source,dir);assert.equal(calls.length,2);
 const changed=JSON.parse(await readFile(calls[1].args[2],'utf8'));assert.notEqual(changed.fingerprint,request.fingerprint);
 assert.equal((await stat(join(request.stateDir,'result.json'))).mode&0o777,0o600);
});
test('Modal readiness is a check without source upload or inference',async t=>{
 const {client,calls}=await fixture(t);assert.equal((await client.check()).state,'ready');
 assert.equal(calls.length,1);assert.equal(calls[0].args[1],'check');
 const missing=new module.ModalTranscriber({}, {runImpl:async()=>({stdout:JSON.stringify({ok:false,code:'NOT_READY'})})});
 assert.equal((await missing.check()).state,'missing');
});
test('cache corruption and symlink storage never become a valid transcript',async t=>{
 const {dir,source,client,calls}=await fixture(t);await client.transcribe(source,dir);
 const request=JSON.parse(await readFile(calls[0].args[2],'utf8'));
 await writeFile(join(request.stateDir,'result.json'),JSON.stringify({fingerprint:request.fingerprint,words:[{text:'bad',start:2,end:1}]}));
 await assert.rejects(()=>client.transcribe(source,dir),/caché|resultado|integridad/i);assert.equal(calls.length,1);
 const other=join(dir,'other');await mkdir(other);const outside=join(dir,'outside');await mkdir(outside);await symlink(outside,join(other,'.modal-transcription'));
 await assert.rejects(()=>client.transcribe(source,other),/enlace|directorio/i);
});
test('uncertain submission surfaces attention without exposing provider diagnostics',async t=>{
 const {dir,source}=await fixture(t);
 const client=new module.ModalTranscriber({}, {runImpl:async()=>({stdout:JSON.stringify({ok:false,code:'UNCERTAIN',message:'provider-secret-do-not-echo'})})});
 await assert.rejects(()=>client.transcribe(source,dir),error=>error.needsAttention===true&&/incierto/i.test(error.message)&&!error.message.includes('provider-secret'));
});

async function pythonFixture(t,mode='success'){
 const dir=await mkdtemp(join(tmpdir(),'modal-asr-python-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=join(dir,'source.mp4'),control=join(dir,'control.json'),events=join(dir,'events.jsonl');
 await writeFile(source,'original-voice');
 await writeFile(control,JSON.stringify({mode,words}));
 await writeFile(join(dir,'modal.py'),`import json,time\nfrom pathlib import Path\nfrom types import SimpleNamespace\nCONTROL=Path(${JSON.stringify(control)})\nEVENTS=Path(${JSON.stringify(events)})\ndef log(event,**kw):\n with EVENTS.open('a') as f:f.write(json.dumps(dict(event=event,**kw))+'\\n')\ndef cfg():return json.loads(CONTROL.read_text())\nclass RemoteTimeout(Exception):pass\nclass OutputExpiredError(Exception):pass\nexception=SimpleNamespace(TimeoutError=RemoteTimeout,FunctionTimeoutError=OutputExpiredError,OutputExpiredError=OutputExpiredError)\nclass NFS:\n def hydrate(self):log('hydrate_nfs')\n def add_local_file(self,source,remote):log('upload',remote=remote)\nclass NetworkFileSystem:\n @staticmethod\n def from_name(name,**kw):log('lookup_nfs',name=name,options=kw);return NFS()\nclass Fn:\n def __init__(self,gpu=None):self.gpu=gpu\n def with_options(self,**kw):log('with_options',options=kw);return Fn(**kw)\n def hydrate(self):\n  log('hydrate_function')\n  if cfg()['mode']=='missing':raise RuntimeError('missing function provider-secret')\n def spawn(self,*args,**kw):\n  log('spawn',args=args,kwargs=kw,gpu=self.gpu)\n  if cfg()['mode']=='ambiguous':raise RuntimeError('lost response provider-secret')\n  return SimpleNamespace(object_id='fc-fixture')\nclass Function:\n @staticmethod\n def from_name(app,name,**kw):log('lookup_function',app=app,name=name,options=kw);return Fn()\nclass Call:\n def get(self,timeout):\n  log('get',timeout=timeout)\n  current=cfg()\n  if current['mode']=='pending':time.sleep(.05);raise RemoteTimeout()\n  if current['mode']=='expired':raise OutputExpiredError()\n  if current['mode']=='hold':time.sleep(.8)\n  return dict(segments=[dict(words=current['words'])])\nclass FunctionCall:\n @staticmethod\n def from_id(value):log('resume',call_id=value);return Call()\n`);
 assert.equal(typeof module.ModalTranscriber,'function');
 const client=new module.ModalTranscriber({rootDir:process.cwd(),pythonPath:'python3',pythonLibs:dir,modalTranscriptionTimeoutMs:11000});
 const log=async()=>{try{return (await readFile(events,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(error){if(error.code==='ENOENT')return [];throw error;}};
 const set=async(mode,overrides={})=>writeFile(control,JSON.stringify({mode,words,...overrides}));
 return {dir,source,client,log,set};
}
test('Python readiness hydrates the existing function and NFS without inference',async t=>{
 const {client,log,set}=await pythonFixture(t);
 assert.equal((await client.check()).state,'ready');
 const events=await log();assert.ok(events.some(e=>e.event==='hydrate_function'));assert.ok(events.some(e=>e.event==='hydrate_nfs'));assert.ok(!events.some(e=>['upload','spawn','get'].includes(e.event)));
 await set('missing');assert.equal((await client.check()).state,'missing');
});
test('Python bridge resumes call_id after timeout and preserves the deployed ASR invocation',async t=>{
 const {dir,source,client,log,set}=await pythonFixture(t,'pending');
 await assert.rejects(()=>client.transcribe(source,dir),e=>e.code==='MODAL_TRANSCRIPTION_RUNNING');
 await set('success');assert.deepEqual(await client.transcribe(source,dir),words);
 const events=await log(),spawns=events.filter(e=>e.event==='spawn');assert.equal(spawns.length,1);
 assert.deepEqual(spawns[0].kwargs,{language:'es',model_name:'large-v3',enable_diarization:false});
 assert.equal(spawns[0].args[1],'source.mp4');assert.ok(!JSON.stringify(spawns).includes(dir));
 assert.ok(events.filter(e=>e.event==='resume').length>=2);
});
test('Python bridge never retries an ambiguous submission or a changed pending identity',async t=>{
 const {dir,source,client,log,set}=await pythonFixture(t,'ambiguous');
 await assert.rejects(()=>client.transcribe(source,dir),e=>e.needsAttention&&/incierto/.test(e.message));
 await set('success');await assert.rejects(()=>client.transcribe(source,dir),e=>e.needsAttention&&/incierto/.test(e.message));
 await writeFile(source,'different-voice');await assert.rejects(()=>client.transcribe(source,dir),e=>e.needsAttention&&/cambiaron/.test(e.message));
 assert.equal((await log()).filter(e=>e.event==='spawn').length,1);
});
test('Python bridge serializes concurrent submissions with a private process lock',async t=>{
 const {dir,source,client,log}=await pythonFixture(t,'hold');
 const first=client.transcribe(source,dir);
 for(let i=0;i<100&&!((await log()).some(e=>e.event==='get'));i++)await new Promise(resolve=>setTimeout(resolve,10));
 await assert.rejects(()=>client.transcribe(source,dir),e=>e.code==='MODAL_TRANSCRIPTION_BUSY');
 assert.deepEqual(await first,words);assert.equal((await log()).filter(e=>e.event==='spawn').length,1);
 assert.equal((await stat(join(dir,'.modal-transcription','operation.lock'))).mode&0o777,0o600);
});
test('invalid remote word timing and expired outputs retain the existing call instead of resubmitting',async t=>{
 const {dir,source,client,log,set}=await pythonFixture(t,'success');
 await set('success',{words:[{text:'bad',start:2,end:1}]});
 await assert.rejects(()=>client.transcribe(source,dir),e=>e.needsAttention&&/inválida/.test(e.message));
 await set('expired');await assert.rejects(()=>client.transcribe(source,dir),e=>e.needsAttention);
 assert.equal((await log()).filter(e=>e.event==='spawn').length,1);
});
test('a corrupted phase or lost call ID cannot authorize another remote submission',async t=>{
 const {dir,source,client,log}=await pythonFixture(t,'success');
 await client.transcribe(source,dir);
 const root=join(dir,'.modal-transcription'),fingerprint=(await readdir(root)).find(name=>/^[a-f0-9]{64}$/.test(name));
 const file=join(root,fingerprint,'state.json'),state=JSON.parse(await readFile(file,'utf8'));
 delete state.call_id;state.phase='broken';await writeFile(file,JSON.stringify(state));
 await assert.rejects(()=>client.transcribe(source,dir),e=>e.needsAttention&&/integridad/.test(e.message));
 assert.equal((await log()).filter(e=>e.event==='spawn').length,1);
});
test('a symlinked Python lock cannot touch files outside the job or submit inference',async t=>{
 const {dir,source,client,log}=await pythonFixture(t);
 const root=join(dir,'.modal-transcription');await mkdir(root);
 const outside=join(dir,'unrelated');await writeFile(outside,'unchanged');await symlink(outside,join(root,'operation.lock'));
 await assert.rejects(()=>client.transcribe(source,dir),e=>e.needsAttention);
 assert.equal(await readFile(outside,'utf8'),'unchanged');assert.equal((await log()).filter(e=>e.event==='spawn').length,0);
});
test('optional A10 changes cache identity without changing legacy settings or the ASR model',async t=>{
 const {dir,source,client,calls}=await fixture(t);
 await client.transcribe(source,dir);
 const legacy=JSON.parse(await readFile(calls[0].args[2],'utf8'));
 assert.ok(!Object.hasOwn(legacy.settings,'gpu'));
 client.config.modalTranscriptionGpu='A10';await client.transcribe(source,dir);
 assert.equal(calls.length,2);
 const accelerated=JSON.parse(await readFile(calls[1].args[2],'utf8'));
 assert.deepEqual(accelerated.settings,{...legacy.settings,gpu:'A10'});
 assert.notEqual(accelerated.fingerprint,legacy.fingerprint);
 await client.transcribe(source,dir);assert.equal(calls.length,2);
 delete client.config.modalTranscriptionGpu;
 assert.deepEqual(await client.transcribe(source,dir),words);assert.equal(calls.length,2);
});
test('Python applies A10 to the returned function while preserving Spanish large-v3 invocation',async t=>{
 const {dir,source,client,log}=await pythonFixture(t);
 client.config.modalTranscriptionGpu='A10';
 assert.equal((await client.check()).state,'ready');
 assert.ok(!(await log()).some(e=>['upload','spawn','get'].includes(e.event)));
 assert.deepEqual(await client.transcribe(source,dir),words);
 const events=await log(),overrides=events.filter(e=>e.event==='with_options'),spawns=events.filter(e=>e.event==='spawn');
 assert.equal(overrides.length,2);assert.ok(overrides.every(e=>JSON.stringify(e.options)==='{"gpu":"A10"}'));
 assert.equal(spawns.length,1);assert.equal(spawns[0].gpu,'A10');
 assert.deepEqual(spawns[0].kwargs,{language:'es',model_name:'large-v3',enable_diarization:false});
});
test('pending legacy call blocks GPU changes and still resumes its original call_id without override',async t=>{
 const {dir,source,client,log,set}=await pythonFixture(t,'pending');
 await assert.rejects(()=>client.transcribe(source,dir),e=>e.code==='MODAL_TRANSCRIPTION_RUNNING');
 const root=join(dir,'.modal-transcription'),active=await readFile(join(root,'active.json'),'utf8');
 const fingerprint=JSON.parse(active).fingerprint,statePath=join(root,fingerprint,'state.json'),state=await readFile(statePath,'utf8');
 client.config.modalTranscriptionGpu='A10';
 await assert.rejects(()=>client.transcribe(source,dir),e=>e.needsAttention&&/cambiaron/.test(e.message));
 assert.equal(await readFile(join(root,'active.json'),'utf8'),active);assert.equal(await readFile(statePath,'utf8'),state);
 delete client.config.modalTranscriptionGpu;await set('success');
 assert.deepEqual(await client.transcribe(source,dir),words);
 const events=await log();assert.equal(events.filter(e=>e.event==='spawn').length,1);
 assert.ok(!events.some(e=>e.event==='with_options'));
 assert.ok(events.filter(e=>e.event==='resume').every(e=>e.call_id==='fc-fixture'));
});
test('Python rejects unsupported GPU overrides and unexpected deployments before lookup or inference',async t=>{
 const {dir,source,client,log}=await pythonFixture(t);
 for(const override of [{modalTranscriptionGpu:'H100'},{modalTranscriptionGpu:'A10',modalTranscriptionApp:'other-app'},{modalTranscriptionGpu:'A10',modalTranscriptionFunction:'other-function'}]){
  Object.assign(client.config,{modalTranscriptionApp:'kavion-whisperx-real',modalTranscriptionFunction:'transcribe_file'},override);
  assert.equal((await client.check()).state,'missing');
  await assert.rejects(()=>client.transcribe(source,dir),e=>e.needsAttention);
 }
 assert.deepEqual(await log(),[]);
});

test('an unaligned numeral keeps its text and fits between timed neighbours without another inference',async t=>{
 const {dir,source,client,log,set}=await pythonFixture(t);
 await set('success',{words:[{word:'hicimos',start:1.29,end:1.55},{word:'2',start:null,end:null},{word:'millones',start:1.731,end:1.991}]});
 const expected=[{text:'hicimos',start:1.29,end:1.55},{text:'2',start:1.55,end:1.731},{text:'millones',start:1.731,end:1.991}];
 assert.deepEqual(await client.transcribe(source,dir),expected);
 assert.deepEqual(await client.transcribe(source,dir),expected);
 const events=await log();assert.equal(events.filter(e=>e.event==='spawn').length,1);
 const root=join(dir,'.modal-transcription'),fingerprint=JSON.parse(await readFile(join(root,'active.json'),'utf8')).fingerprint;
 const result=JSON.parse(await readFile(join(root,fingerprint,'result.json'),'utf8'));
 assert.deepEqual(result.timingRepairs,[{wordIndex:1,text:'2',start:1.55,end:1.731,method:'bounded-numeral-gap'}]);
});

test('missing alignment stays blocked when no short isolated numeral gap can be established',async t=>{
 const {dir,source,client,log,set}=await pythonFixture(t);
 const before={word:'hicimos',start:1.29,end:1.55},missing={word:'2',start:null,end:null},after={word:'millones',start:1.731,end:1.991};
 for(const invalid of [[missing,after],[before,missing],[before,{...missing,word:'algo'},after],[before,missing,{...after,start:2.2,end:2.4}],[before,missing,missing,after],[before,{...missing,start:1.6},after],[before,missing,{...after,start:1.5}],[before,{...missing,start:'1.6'},after]]){
  await set('success',{words:invalid});
  await assert.rejects(()=>client.transcribe(source,dir),e=>e.needsAttention&&/inválida/.test(e.message));
 }
 assert.equal((await log()).filter(e=>e.event==='spawn').length,1);
});

test('numeral timing recovery never bridges separate ASR segments',async()=>{
 const script=`import importlib.util
s=importlib.util.spec_from_file_location('bridge','scripts/transcribe-modal.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
before={'word':'hicimos','start':1.29,'end':1.55}
missing={'word':'2','start':None,'end':None}
after={'word':'millones','start':1.731,'end':1.991}
for segments in ([{'words':[before,missing]},{'words':[after]}],[{'words':[before]},{'words':[missing,after]}]):
 try:m.normalize({'segments':segments},600)
 except m.BridgeError as e:assert e.code=='INVALID_RESULT'
 else:raise AssertionError('Cross-segment repair accepted')
print('segment boundaries preserved')`;
 const result=await runMediaCommand('python3',['-c',script],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONPATH:'scripts'}});
 assert.match(result.stdout,/segment boundaries preserved/);
});


test('a spoken numeral can occupy a 380ms word gap without being treated as excess silence',async t=>{
 const {dir,source,client,log,set}=await pythonFixture(t);
 await set('success',{words:[{word:'ser',start:18.121,end:18.241},{word:'100,',start:null,end:null},{word:'no.',start:18.621,end:18.701}]});
 const expected=[{text:'ser',start:18.121,end:18.241},{text:'100,',start:18.241,end:18.621},{text:'no.',start:18.621,end:18.701}];
 assert.deepEqual(await client.transcribe(source,dir),expected);
 assert.deepEqual(await client.transcribe(source,dir),expected);
 assert.equal((await log()).filter(e=>e.event==='spawn').length,1);
 const root=join(dir,'.modal-transcription'),fingerprint=JSON.parse(await readFile(join(root,'active.json'),'utf8')).fingerprint;
 const result=JSON.parse(await readFile(join(root,fingerprint,'result.json'),'utf8'));
 assert.deepEqual(result.timingRepairs,[{wordIndex:1,text:'100,',start:18.241,end:18.621,method:'bounded-numeral-gap'}]);
});

test('numeral recovery accepts half-second speech and rejects longer uncertain gaps',async()=>{
 const script=`import importlib.util
s=importlib.util.spec_from_file_location('bridge','scripts/transcribe-modal.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
before={'word':'subo','start':1,'end':1.2}
missing={'word':'100','start':None,'end':None}
repairs=[]
assert m.normalize({'segments':[{'words':[before,missing,{'word':'videos','start':1.7,'end':2}]}]},600,repairs)==[{'text':'subo','start':1,'end':1.2},{'text':'100','start':1.2,'end':1.7},{'text':'videos','start':1.7,'end':2}]
assert len(repairs)==1
try:m.normalize({'segments':[{'words':[before,missing,{'word':'videos','start':1.701,'end':2}]}]},600)
except m.BridgeError as e:assert e.code=='INVALID_RESULT'
else:raise AssertionError('Uncertain numeral gap accepted')
print('speech gap bounded independently of silence trimming')`;
 const result=await runMediaCommand('python3',['-c',script],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONPATH:'scripts'}});
 assert.match(result.stdout,/speech gap bounded/);
});
