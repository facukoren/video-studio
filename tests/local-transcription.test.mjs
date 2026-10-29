import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,stat,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runMediaCommand} from '../src/media.mjs';

const module = await import('../src/local-transcription.mjs').catch(()=>({}));
const words=[{text:'Hola',start:.1,end:.4},{text:'mundo.',start:.4,end:.9}];
async function fixture(t,options={}) {
 const dir=await mkdtemp(join(tmpdir(),'local-whisper-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=join(dir,'voice.mp4');await writeFile(source,'original-voice');
 const calls=[];
 const runImpl=async(binary,args,opts)=>{
  calls.push({binary,args,opts});
  if(args[1]==='check')return {stdout:JSON.stringify({ready:true,version:'1.2.1',modelFingerprint:'medium-v1'})};
  const request=JSON.parse(await readFile(args[2],'utf8'));
  await writeFile(request.output,JSON.stringify({duration:1,words:options.words??words,model:'medium',compute_type:'int8'}));
  return {stdout:''};
 };
 assert.equal(typeof module.LocalTranscriber,'function','local transcription runtime is available');
 const config={rootDir:process.cwd(),localPythonPath:'local-python',localWhisperModelPath:join(dir,'medium'),localTranscriptionMinMemoryMb:3072};
 const client=new module.LocalTranscriber(config,{runImpl,memoryImpl:()=>options.memory??4096});
 return {client,config,source,dir,calls};
}

test('local transcription invokes offline medium int8 and caches by actual source content',async t=>{
 const {client,source,dir,calls}=await fixture(t);
 assert.deepEqual(await client.transcribe(source,dir),words);
 const call=calls.find(c=>c.args[1]==='transcribe');
 assert.equal(call.binary,'local-python');
 const request=JSON.parse(await readFile(call.args[2],'utf8'));
 assert.equal(request.model,'medium');assert.equal(request.computeType,'int8');assert.equal(request.threads,2);assert.equal(request.language,'es');
 assert.deepEqual(await client.transcribe(source,dir),words);
 assert.equal(calls.filter(c=>c.args[1]==='transcribe').length,1);
 await writeFile(source,'changed!-voice');
 await client.transcribe(source,dir);
 assert.equal(calls.filter(c=>c.args[1]==='transcribe').length,2);
 const state=JSON.parse(await readFile(join(dir,'local-transcription-state.json'),'utf8'));
 assert.equal(state.model,'medium');assert.equal(state.computeType,'int8');
 if(process.platform!=='win32')assert.equal((await stat(join(dir,'local-transcription-state.json'))).mode&0o777,0o600);
});

test('insufficient memory reports a retryable visible wait without starting inference',async t=>{
 const {client,source,dir,calls}=await fixture(t,{memory:1400});
 const status=await client.check();assert.equal(status.state,'waiting');assert.match(status.detail,/3072|memoria/i);
 await assert.rejects(client.transcribe(source,dir),e=>e.code==='LOCAL_RESOURCES_WAIT'&&/memoria/i.test(e.message));
 assert.equal(calls.filter(c=>c.args[1]==='transcribe').length,0);
});

test('an overlapping transcript is rejected instead of saved as a valid checkpoint',async t=>{
 const {client,source,dir}=await fixture(t,{words:[words[0],{text:'bad',start:.3,end:.8}]});
 await assert.rejects(client.transcribe(source,dir),/tiempo|superpuest/i);
 await assert.rejects(stat(join(dir,'local-transcription-state.json')),e=>e.code==='ENOENT');
});

test('a corrupted cached transcript is never returned',async t=>{
 const {client,source,dir}=await fixture(t);await client.transcribe(source,dir);
 const file=join(dir,'local-transcription-state.json'),state=JSON.parse(await readFile(file,'utf8'));
 state.words=[{text:'invalid',start:2,end:1}];await writeFile(file,JSON.stringify(state));
 await assert.rejects(client.transcribe(source,dir),/tiempo/i);
});

test('missing local dependencies remain missing without provider fallback',async t=>{
 const {config}=await fixture(t);
 const client=new module.LocalTranscriber(config,{runImpl:async()=>({stdout:JSON.stringify({ready:false,detail:'Falta faster-whisper local.'})}),memoryImpl:()=>4096});
 assert.deepEqual(await client.check(),{state:'missing',detail:'Falta faster-whisper local.'});
});

test('model and precision changes invalidate a previously completed transcript',async t=>{
 const {client,source,dir,calls}=await fixture(t);await client.transcribe(source,dir);
 client.config.localWhisperComputeType='float32';await client.transcribe(source,dir);
 assert.equal(calls.filter(c=>c.args[1]==='transcribe').length,2);
});

test('the Python runner uses only local weights and single-worker medium inference',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'whisper-python-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const modelPath=join(dir,'medium');await mkdir(modelPath);
 for(const name of ['model.bin','config.json','tokenizer.json'])await writeFile(join(modelPath,name),'fixture');
 const dist=join(dir,'faster_whisper-1.2.1.dist-info');await mkdir(dist);await writeFile(join(dist,'METADATA'),'Metadata-Version: 2.1\nName: faster-whisper\nVersion: 1.2.1\n');
 await writeFile(join(dir,'faster_whisper.py'),`from types import SimpleNamespace\nclass WhisperModel:\n def __init__(self,path,**kw):\n  assert path.endswith('medium')\n  assert kw == dict(device='cpu',compute_type='int8',cpu_threads=2,num_workers=1,local_files_only=True)\n def transcribe(self,source,**kw):\n  assert kw == dict(language='es',beam_size=5,word_timestamps=True,vad_filter=True,condition_on_previous_text=True)\n  return iter([SimpleNamespace(words=[SimpleNamespace(word=' Hola',start=.1,end=.4)])]),SimpleNamespace(duration=1,language='es')\n`);
 const settings={model:'medium',modelPath,device:'cpu',computeType:'int8',threads:2,source:join(dir,'source.mp4'),output:join(dir,'result.json')};
 const script=join(process.cwd(),'scripts/transcribe-local.py'),env={PYTHONPATH:dir,PYTHONDONTWRITEBYTECODE:'1'};
 const checked=await runMediaCommand('python3',[script,'check',JSON.stringify(settings)],{env});assert.equal(JSON.parse(checked.stdout).ready,true);
 const request=join(dir,'request.json');await writeFile(request,JSON.stringify(settings));
 await runMediaCommand('python3',[script,'transcribe',request],{env});
 const result=JSON.parse(await readFile(settings.output,'utf8'));assert.deepEqual(result.words,[words[0]]);assert.equal(result.model,'medium');
 await rm(join(modelPath,'model.bin'));
 const missing=await runMediaCommand('python3',[script,'check',JSON.stringify(settings)],{env});assert.equal(JSON.parse(missing.stdout).ready,false);
});
