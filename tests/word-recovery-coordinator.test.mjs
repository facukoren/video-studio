import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {ModalTranscriber} from '../src/modal-transcription.mjs';
import {loadConfig} from '../src/config.mjs';
const want=[{text:'100',start:.1,end:.4},{text:'videos',start:.5,end:.8},{text:'día',start:1,end:1.3}];
async function fixture(t,mode='success'){
 const dir=await mkdtemp(join(tmpdir(),'word-recovery-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const control=join(dir,'control.json'),events=join(dir,'events.jsonl'),source=join(dir,'source.mp4');
 await writeFile(source,'same-private-source');await writeFile(control,JSON.stringify({mode}));
 await writeFile(join(dir,'modal.py'),`import json,time\nfrom pathlib import Path\nfrom types import SimpleNamespace\nC=Path(${JSON.stringify(control)});E=Path(${JSON.stringify(events)})\ndef cfg():return json.loads(C.read_text())\ndef log(kind,**kw):\n with E.open('a') as f:f.write(json.dumps(dict(kind=kind,**kw))+'\\n')\nclass RemoteTimeout(Exception):pass\nclass OutputExpiredError(Exception):pass\nexception=SimpleNamespace(TimeoutError=RemoteTimeout)\nclass NFS:\n def hydrate(self):pass\n def add_local_file(self,*args):log('upload')\nclass NetworkFileSystem:\n @staticmethod\n def from_name(*args,**kw):return NFS()\nclass Fn:\n def __init__(self,name):self.name=name\n def hydrate(self):pass\n def with_options(self,**kw):return self\n def spawn(self,*args,**kw):\n  if self.name=='transcribe_file':log('asr_spawn');return SimpleNamespace(object_id='fc-asr')\n  log('align_spawn');c=cfg();c['args']=args;C.write_text(json.dumps(c))\n  if c['mode']=='ambiguous':raise RuntimeError('provider-private-trace')\n  return SimpleNamespace(object_id='fc-align')\nclass Function:\n @staticmethod\n def from_name(app,name,**kw):log('lookup',name=name);return Fn(name)\nclass Call:\n def __init__(self,id):self.id=id\n def get(self,timeout):\n  c=cfg();mode=c['mode']\n  if self.id=='fc-asr':\n   log('asr_get')\n   if mode=='asr-expired':raise OutputExpiredError()\n   if mode=='mixed-global':return dict(word_segments=[dict(word='100',start=.1,end=.4)],segments=[dict(start=0,end=.4,words=[dict(word='100',start=.1,end=.4)]),dict(start=.5,end=1.3,text='videos día',words=[])])\n   if mode=='mixed-text':return dict(segments=[dict(start=0,end=.8,words=[dict(word='100',start=.1,end=.4),dict(word='videos',start=.5,end=.8)]),dict(start=1,end=1.3,text='día')])\n   if mode=='valid':return dict(words=${JSON.stringify(want)})\n   if mode=='bad-shape':return dict(words=[None])\n   return dict(segments=[dict(start=0,end=1.5,words=[dict(word='100',start=None,end=None),dict(word='videos',start=None,end=None),dict(word='día',start=1,end=1.3)])])\n  log('align_get')\n  if mode=='running':time.sleep(.05);raise RemoteTimeout()\n  if mode=='align-expired':raise OutputExpiredError()\n  args=c['args'];words=${JSON.stringify(want)}\n  if mode=='changed-text':words[0]['text']='200'\n  result=dict(contract='kavion-word-alignment-v1',sourceHash=args[1],rawHash=args[2],duration=1.5,words=words,acousticEvidence=dict(policy='ctc-confidence-v1',meanScore=.8,supportedRatio=1,wordCount=len(words)),model='VOXPOPULI_ASR_BASE_10K_ES',language='es')\n  if mode=='wrong-hash':result['rawHash']='0'*64\n  if mode=='no-duration':del result['duration'];result['words']=[dict(text=w['text'],start=499+i*.2,end=499.1+i*.2) for i,w in enumerate(words)]\n  if mode=='bad-duration':result['duration']='1.5'\n  return result\nclass FunctionCall:\n @staticmethod\n def from_id(id):return Call(id)\n`);
 const config={...loadConfig({DATA_DIR:dir}),pythonPath:'python3',pythonLibs:dir,modalTranscriptionTimeoutMs:11000};
 const client=new ModalTranscriber(config);
 const set=async mode=>{const c=JSON.parse(await readFile(control,'utf8'));await writeFile(control,JSON.stringify({...c,mode}));};
 const log=async()=>{try{return (await readFile(events,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return [];throw e;}};
 const stateDir=async()=>{const a=JSON.parse(await readFile(join(dir,'.modal-transcription/active.json'),'utf8'));return join(dir,'.modal-transcription',a.fingerprint);};
 return {dir,source,client,set,log,stateDir};
}

test('production configuration automatically recovers missing edge and consecutive words once',async t=>{
 const {dir,source,client,log,stateDir}=await fixture(t);
 assert.deepEqual(await client.transcribe(source,dir),want);assert.deepEqual(await client.transcribe(source,dir),want);
 const events=await log();assert.equal(events.filter(e=>e.kind==='asr_spawn').length,1);assert.equal(events.filter(e=>e.kind==='align_spawn').length,1);
 const root=await stateDir(),state=JSON.parse(await readFile(join(root,'state.json'),'utf8'));assert.equal(state.call_id,'fc-asr');assert.equal(state.alignment.call_id,'fc-align');assert.equal(state.phase,'complete');
 assert.equal((await stat(join(root,'raw-result.json'))).mode&0o777,0o600);assert.equal((await stat(join(root,'alignment-result.json'))).mode&0o777,0o600);
});

test('a pending alignment resumes saved raw text even when the ASR output expires',async t=>{
 const {dir,source,client,log,set}=await fixture(t,'running');
 await assert.rejects(()=>client.transcribe(source,dir),e=>e.code==='MODAL_TRANSCRIPTION_RUNNING');
 await set('asr-expired');assert.deepEqual(await client.transcribe(source,dir),want);
 const events=await log();assert.equal(events.filter(e=>e.kind==='asr_get').length,1);assert.equal(events.filter(e=>e.kind==='asr_spawn').length,1);assert.equal(events.filter(e=>e.kind==='align_spawn').length,1);
});

test('an ambiguous alignment submission retains its marker and never submits again',async t=>{
 const {dir,source,client,log,set}=await fixture(t,'ambiguous');
 await assert.rejects(()=>client.transcribe(source,dir),e=>e.needsAttention&&/incierto/.test(e.message));
 await set('success');await assert.rejects(()=>client.transcribe(source,dir),e=>e.needsAttention&&/incierto/.test(e.message));
 assert.equal((await log()).filter(e=>e.kind==='align_spawn').length,1);assert.equal((await log()).filter(e=>e.kind==='asr_spawn').length,1);
});

test('changed recovery identity and corrupt raw cache cannot authorize a new call',async t=>{
 const {dir,source,client,log,stateDir}=await fixture(t,'running');
 await assert.rejects(()=>client.transcribe(source,dir));
 const original=client.config.modalAlignmentRecovery;client.config.modalAlignmentRecovery={...original,contract:'changed'};
 await assert.rejects(()=>client.transcribe(source,dir),e=>e.needsAttention);
 client.config.modalAlignmentRecovery=original;
 await writeFile(join(await stateDir(),'raw-result.json'),'{}');
 await assert.rejects(()=>client.transcribe(source,dir),e=>e.needsAttention);
 assert.equal((await log()).filter(e=>e.kind==='align_spawn').length,1);
});

test('bad recovery output and expired recovery calls retain IDs without retrying inference',async t=>{
 for(const mode of ['changed-text','wrong-hash','align-expired']){
  const {dir,source,client,log,set}=await fixture(t,mode);
  await assert.rejects(()=>client.transcribe(source,dir),e=>e.needsAttention);
  await set('align-expired');await assert.rejects(()=>client.transcribe(source,dir),e=>e.needsAttention);
  assert.equal((await log()).filter(e=>e.kind==='asr_spawn').length,1);assert.equal((await log()).filter(e=>e.kind==='align_spawn').length,1);
 }
});

test('valid word timings and malformed transcript shapes do not invoke recovery',async t=>{
 for(const mode of ['valid','bad-shape']){
  const {dir,source,client,log}=await fixture(t,mode);
  if(mode==='valid')assert.deepEqual(await client.transcribe(source,dir),want);else await assert.rejects(()=>client.transcribe(source,dir));
  assert.equal((await log()).filter(e=>e.kind==='align_spawn').length,0);
 }
});


test('a segment without word timings cannot disappear beside already timed segments',async t=>{
 const {dir,source,client,log}=await fixture(t,'mixed-text');
 assert.deepEqual(await client.transcribe(source,dir),want);
 assert.equal((await log()).filter(e=>e.kind==='align_spawn').length,1);
});


test('global word segments cannot hide unaligned segment text',async t=>{
 const {dir,source,client,log}=await fixture(t,'mixed-global');
 assert.deepEqual(await client.transcribe(source,dir),want);
 assert.equal((await log()).filter(e=>e.kind==='align_spawn').length,1);
});

test('recovery requires an explicit finite duration for its returned timing bounds',async t=>{
 for(const mode of ['no-duration','bad-duration']){
  const {dir,source,client,log}=await fixture(t,mode);
  await assert.rejects(()=>client.transcribe(source,dir),e=>e.needsAttention);
  await assert.rejects(()=>client.transcribe(source,dir),e=>e.needsAttention);
  assert.equal((await log()).filter(e=>e.kind==='align_spawn').length,1);
 }
});
