import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,truncate} from 'node:fs/promises';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {Readable} from 'node:stream';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute = promisify(execFile);
const fixturePlan=()=>({creativeIntent:'Composición de prueba con palabra anclada.',captionGroups:[{startWord:0,endWord:0,emphasis:[0],position:'lower'}],zooms:[],overlays:[],brolls:[{start:0,duration:1,prompt:'Synthetic fixture media for testing',quote:'Hola'}]});
const remote = await import('../src/remote-media.mjs').catch(()=>({}));

test('B-roll pixel repair has an immutable remote identity and rejects unsafe regions before upload',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'kavion-broll-repair-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=join(dir,'source.mp4');await writeFile(source,'original paid asset');const requests=[];
 const media=new remote.RemoteMedia({rootDir:resolve('.'),dataDir:dir},{runImpl:async(_cmd,args)=>{
  const request=JSON.parse(await readFile(args[2],'utf8'));requests.push(request);
  return {stdout:JSON.stringify({ok:true,result:{path:'repaired-broll.mp4',regions:request.payload.regions}})};
 }});
 assert.equal(typeof media.repairBrollVideo,'function');
 const regions=[{x:.2,y:.3,width:.4,height:.2}];
 const result=await media.repairBrollVideo(source,regions,dir);
 assert.equal(result.path,join(dir,'repaired-broll.mp4'));assert.deepEqual(result.regions,regions);
 assert.equal(requests[0].operation,'repair-broll');assert.deepEqual(requests[0].payload,{regions});
 assert.equal(requests[0].inputs[0].path,source);
 await media.repairBrollVideo(source,regions,dir);assert.equal(requests[0].requestHash,requests[1].requestHash);
 for(const bad of [[],[{x:0,y:0,width:1,height:1}],[{x:-.1,y:0,width:.3,height:.3}],[{x:0,y:0,width:NaN,height:.3}]])await assert.rejects(media.repairBrollVideo(source,bad,dir));
 assert.equal(requests.length,2);assert.equal(await readFile(source,'utf8'),'original paid asset');
 const timed=[{x:.2,y:.3,width:.4,height:.2,start:.5,end:1.5}];
 const treated=await media.repairBrollVideo(source,timed,dir);assert.deepEqual(treated.regions,timed);assert.deepEqual(requests[2].payload,{regions:timed});
 assert.notEqual(requests[0].requestHash,requests[2].requestHash,'timing changes pixel treatment identity');
 for(const region of [{...timed[0],end:.4},{...timed[0],start:NaN},{x:.2,y:.3,width:.4,height:.2,start:.5}])await assert.rejects(media.repairBrollVideo(source,[region],dir));
 assert.equal(requests.length,3,'invalid timing never uploads the paid source');
});

for (const code of ['MODAL_MEDIA_RUNNING','MODAL_MEDIA_BUSY']) test(`known remote wait ${code} remains resumable instead of requiring manual review`,async t=>{
 const dir=await mkdtemp(join(tmpdir(),'kavion-remote-wait-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=join(dir,'source.mp4');await writeFile(source,'fixture');
 const requests=[];
 const media=new remote.RemoteMedia({rootDir:resolve('.'),dataDir:dir},{runImpl:async(_cmd,args)=>{
  requests.push(JSON.parse(await readFile(args[2],'utf8')));
  return {stdout:JSON.stringify({ok:false,error:'Provider is still processing /private/trace',code,needsAttention:false})};
 }});
 for(let n=0;n<2;n++)await assert.rejects(media.cutVideo(source,[{text:'Hola',start:0,end:1}],dir),error=>error.code===code&&!error.needsAttention&&!error.message.includes('/private/'));
 assert.equal(requests[0].requestHash,requests[1].requestHash);
});

test('Python media polling timeout preserves the submitted call and returns a typed automatic wait',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'kavion-poll-wait-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const script=String.raw`
import importlib.util,os,sys,json
from pathlib import Path
os.environ['KAVION_MEDIA_CLIENT_MODE']='1'
spec=importlib.util.spec_from_file_location('bridge',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path(sys.argv[2]);state=root/'state.json'
request={'runtimeContract':'astra-v3','runtimeFingerprint':m.runtime_fingerprint(),'schema':1,'operation':'verify','jobKey':'a'*64,'requestHash':'b'*64,'payload':{},'inputs':[],'timeoutSeconds':1}
m.atomic_save(state,{'requestHash':'b'*64,'call_id':'fc-existing','phase':'submitted'})
calls=[]
class Call:
 def get(self,timeout):calls.append('poll');raise TimeoutError()
class SDK:
 FunctionCall=type('FC',(),{'from_id':staticmethod(lambda call_id:Call())})
 Volume=type('V',(),{'from_name':staticmethod(lambda *a,**k:object())})
 exception=type('E',(),{'FunctionTimeoutError':type('FunctionTimeoutError',(Exception,),{}),'OutputExpiredError':type('OutputExpiredError',(Exception,),{})})
ticks=iter([0,0,2]);m.time.monotonic=lambda:next(ticks)
try:m.run_client(request,state,root,sdk=SDK)
except Exception as error:print(json.dumps({'code':getattr(error,'code',None),'needsAttention':getattr(error,'needs_attention',False),'state':json.loads(state.read_text()),'calls':calls}))
`;
 const {stdout}=await execute('python3',['-c',script,resolve('scripts/media_modal.py'),dir]);const result=JSON.parse(stdout);
 assert.equal(result.code,'MODAL_MEDIA_RUNNING');assert.equal(result.needsAttention,false);
 assert.equal(result.state.call_id,'fc-existing');assert.equal(result.state.phase,'submitted');assert.deepEqual(result.calls,['poll']);
});

test('a quality revision has a new operation identity and retains the original submitted receipt',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'kavion-quality-namespace-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=join(dir,'source.mp4');await writeFile(source,'fixture');
 const requests=[];
 const media=new remote.RemoteMedia({rootDir:resolve('.'),dataDir:dir},{runImpl:async(_cmd,args)=>{
  const request=JSON.parse(await readFile(args[2],'utf8'));requests.push(request);
  await writeFile(args[3],JSON.stringify({requestHash:request.requestHash,call_id:`fc-${requests.length}`,phase:'downloaded'}));
  return {stdout:JSON.stringify({ok:true,result:{path:'cut.mp4'}})};
 }});
 const words=[{text:'Hola',start:0,end:1}];
 await media.cutVideo(source,words,dir);
 const original=await readFile(join(dir,'.remote-media/cut/state.json'),'utf8');
 const revision=join(dir,'recovery','technical-1');
 await media.cutVideo(source,words,revision);
 await media.cutVideo(source,words,revision);
 assert.notEqual(requests[0].requestHash,requests[1].requestHash);
 assert.equal(requests[1].requestHash,requests[2].requestHash);
 assert.equal(await readFile(join(dir,'.remote-media/cut/state.json'),'utf8'),original);
});

test('Astra render profile gives unchanged media a new durable request identity and remains stable on resume',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'kavion-render-profile-'));
  try{
    const source=join(dir,'cut.mp4');await writeFile(source,'existing cut');
    const requests=[];
    const media=new remote.RemoteMedia({rootDir:resolve('.'),dataDir:dir},{runImpl:async(_cmd,args)=>{
      requests.push(JSON.parse(await readFile(args[2],'utf8')));
      return {stdout:JSON.stringify({ok:true,result:{path:'final.mp4'}}),stderr:''};
    }});
    const input={source,words:[{text:'Hola',start:0,end:1}],duration:1,width:1080,height:1920,dir,plan:fixturePlan(),brolls:[{path:source,start:0,duration:1}]};
    await media.renderVideo(input);
    const current=requests.at(-1),legacyPayload={...current.payload};delete legacyPayload.renderProfile;
    await media.operation('render',legacyPayload,current.inputs,dir);
    await media.renderVideo(input);
    assert.equal(current.payload.renderProfile,'astra-v3');
    assert.notEqual(current.requestHash,requests[1].requestHash,'an old HDR receipt must have a different remote namespace');
    assert.equal(current.requestHash,requests[2].requestHash,'resuming the corrected profile must preserve submission identity');
    assert.equal(current.payload.width,1080);assert.equal(current.payload.height,1920);
    assert.deepEqual(current.inputs,requests[1].inputs);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('remote render and verification accept expanded intermediates through 10 GiB while originals remain capped at 2 GiB',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'kavion-remote-size-'));
  // Sparse files exercise actual stat limits; hashing multi-GiB zero regions
  // would burden the host without testing the transfer-size policy.
  t.mock.method(fs,'createReadStream',()=>Readable.from(['controlled-hash-input']));
  syncBuiltinESMExports();
  try{
    const file=join(dir,'large.mp4');await writeFile(file,'');
    const media=new remote.RemoteMedia({rootDir:resolve('.'),dataDir:dir},{runImpl:async(_cmd,args)=>{
      const request=JSON.parse(await readFile(args[2],'utf8'));
      return {stdout:JSON.stringify({ok:true,result:request.operation==='render'?{path:'final.mp4'}:{ok:true}}),stderr:''};
    }});
    const words=[{text:'Hola',start:0,end:1}];
    for(const size of [2*1024**3+1,10*1024**3]){
      await truncate(file,size);
      assert.equal(await media.renderVideo({source:file,words,duration:1,width:360,height:640,dir,plan:fixturePlan(),brolls:[{path:file,start:0,duration:1}]}),join(dir,'final.mp4'));
      assert.equal((await media.verifyVideo(file)).ok,true);
      await assert.rejects(media.cutVideo(file,words,dir),/2 GiB/);
    }
    await truncate(file,10*1024**3+1);
    await assert.rejects(media.renderVideo({source:file,words,duration:1,width:360,height:640,dir,plan:fixturePlan(),brolls:[{path:file,start:0,duration:1}]}),/10 GiB/);
    await assert.rejects(media.verifyVideo(file),/10 GiB/);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();await rm(dir,{recursive:true,force:true});}
});

test('Python bridge enforces operation-specific media limits before any upload or submission',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'kavion-modal-size-'));
  try{
    const script=String.raw`
import importlib.util,os,sys,json
from pathlib import Path
os.environ['KAVION_MEDIA_CLIENT_MODE']='1'
spec=importlib.util.spec_from_file_location('media_bridge',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path(sys.argv[2]);file=root/'sparse.mp4';m.hash_file=lambda path:'c'*64
rows=[]
for operation,size in [('cut',2*1024**3),('cut',2*1024**3+1),('render',2*1024**3+1),('render',10*1024**3),('render',10*1024**3+1),('verify',10*1024**3),('verify',10*1024**3+1)]:
 with file.open('wb') as handle:handle.truncate(size)
 calls={'upload':0,'spawn':0}
 request={'runtimeContract':'astra-v3','runtimeFingerprint':m.runtime_fingerprint(),'schema':1,'operation':operation,'jobKey':'a'*64,'requestHash':'b'*64,'payload':{},'inputs':[{'name':'source.mp4','path':str(file),'size':size,'sha256':'c'*64}]}
 receipt={'ok':True,'runtimeContract':'astra-v3','runtimeFingerprint':m.runtime_fingerprint(),'requestHash':'b'*64,'operation':operation,'result':{},'files':[]}
 class Upload:
  def __enter__(self):calls['upload']+=1;return self
  def __exit__(self,*args):return False
  def put_file(self,*args,**kwargs):pass
 class Function:
  def hydrate(self):return self
  def spawn(self,*args):calls['spawn']+=1;return type('Call',(),{'object_id':'fc-test'})()
 class SDK:
  Function=type('F',(),{'from_name':staticmethod(lambda *a,**k:Function())})
  FunctionCall=type('C',(),{'from_id':staticmethod(lambda *a,**k:type('Call',(),{'get':lambda self,timeout:receipt})())})
  Volume=type('V',(),{'from_name':staticmethod(lambda *a,**k:type('Volume',(),{'batch_upload':lambda self,**kw:Upload()})())})
  exception=type('E',(),{'FunctionTimeoutError':type('FunctionTimeoutError',(Exception,),{}),'OutputExpiredError':type('OutputExpiredError',(Exception,),{})})
 try:m.run_client(request,root/f'{operation}-{size}.json',root,sdk=SDK);ok=True
 except Exception:ok=False
 rows.append({'operation':operation,'size':size,'ok':ok,**calls})
print(json.dumps(rows))
`;
    const {stdout}=await execute('python3',['-c',script,resolve('scripts/media_modal.py'),dir]);
    const rows=JSON.parse(stdout);
    assert.deepEqual(rows.map(row=>row.ok),[true,false,true,true,false,true,false]);
    for(const row of rows.filter(row=>!row.ok))assert.equal(row.upload+row.spawn,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('remote cut sends only declared media and returns the same local media contract', async()=>{
  assert.equal(typeof remote.RemoteMedia,'function');
  const dir=await mkdtemp(join(tmpdir(),'kavion-remote-'));
  try {
    const source=join(dir,'source.mp4');await writeFile(source,'synthetic');
    let sent;
    const media=new remote.RemoteMedia({rootDir:resolve('.'),dataDir:dir,deepseekKey:'must-not-transfer',googleClientSecret:'must-not-transfer',pythonPath:'python3'}, {runImpl:async(_command,args)=>{
      assert.equal(args[1],'client');sent=JSON.parse(await readFile(args[2],'utf8'));
      await writeFile(join(dir,'cut.mp4'),'cut');
      return {stdout:JSON.stringify({ok:true,result:{path:'cut.mp4',words:[{text:'Hola',start:.1,end:.5}],duration:.6,segments:[{start:0,end:.6,outputStart:0}]}}),stderr:''};
    }});
    const result=await media.cutVideo(source,[{text:'Hola',start:.1,end:.5}],dir);
    assert.equal(result.path,join(dir,'cut.mp4'));
    assert.equal(result.duration,.6);
    assert.equal(sent.operation,'cut');
    assert.equal(sent.inputs.length,1);
    assert.equal(sent.inputs[0].name,'source.mp4');
    assert.equal(sent.inputs[0].sha256.length,64);
    assert.ok(!JSON.stringify(sent).includes('must-not-transfer'));
    assert.ok(!JSON.stringify(sent).includes('googleClientSecret'));
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('remote adapter surfaces ambiguous submission as attention and confines returned paths',async()=>{
  assert.equal(typeof remote.RemoteMedia,'function');
  const dir=await mkdtemp(join(tmpdir(),'kavion-remote-error-'));
  try {
    const source=join(dir,'source.mp4');await writeFile(source,'synthetic');
    let response={ok:false,error:'Envío incierto; revisar Modal. Stack trace /private/vendor/internal.js',needsAttention:true};
    const media=new remote.RemoteMedia({rootDir:resolve('.'),dataDir:dir},{runImpl:async()=>({stdout:JSON.stringify(response),stderr:''})});
    await assert.rejects(media.cutVideo(source,[{text:'Hola',start:0,end:.5}],dir),e=>e.needsAttention===true&&/incierto/.test(e.message)&&!e.message.includes('/private/'));
    assert.equal(await readFile(join(dir,'.remote-media/cut/error.log'),'utf8'),response.error);
    response={ok:true,result:{path:'../../outside.mp4',words:[],duration:1,segments:[]}};
    await assert.rejects(media.cutVideo(source,[{text:'Hola',start:0,end:.5}],dir),/ruta|path/i);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('remote verifier forwards expected duration, dimensions and final word without caller secrets',async()=>{
  assert.equal(typeof remote.RemoteMedia,'function');
  const dir=await mkdtemp(join(tmpdir(),'kavion-remote-verify-'));
  try {
    const source=join(dir,'final.mp4');await writeFile(source,'synthetic');let sent;
    const media=new remote.RemoteMedia({rootDir:resolve('.'),dataDir:dir},{runImpl:async(_cmd,args)=>{sent=JSON.parse(await readFile(args[2],'utf8'));return {stdout:JSON.stringify({ok:true,result:{ok:false,issues:['truncated'],duration:1,maxSilence:0}}),stderr:''};}});
    const result=await media.verifyVideo(source,{expectedDuration:3,expectedWidth:360,expectedHeight:640,expectedWordEnd:2.9,deepseekKey:'secret'});
    assert.equal(result.ok,false);assert.equal(sent.payload.expectedDuration,3);assert.equal(sent.payload.expectedWordEnd,2.9);
    assert.ok(!JSON.stringify(sent).includes('secret'));
  } finally {await rm(dir,{recursive:true,force:true});}
});

const pythonRecovery = String.raw`
import importlib.util,os,sys,json,hashlib
from pathlib import Path
os.environ['KAVION_MEDIA_CLIENT_MODE']='1'
spec=importlib.util.spec_from_file_location('media_bridge',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path(sys.argv[2]);mode=sys.argv[3];state=root/'state.json'
request={'runtimeContract':'astra-v3','runtimeFingerprint':m.runtime_fingerprint(),'schema':1,'operation':'verify','jobKey':'a'*64,'requestHash':'b'*64,'app':'test-app','volume':'test-volume','payload':{},'inputs':[],'timeoutSeconds':1}
receipt={'ok':True,'runtimeContract':'astra-v3','runtimeFingerprint':m.runtime_fingerprint(),'requestHash':'b'*64,'operation':'verify','result':{'ok':True,'duration':1,'maxSilence':0,'issues':[]},'files':[]}
calls={'spawn':0,'poll':0,'hydrate':0}
class Function:
 def hydrate(self):calls['hydrate']+=1;return self
 def spawn(self,*args):
  calls['spawn']+=1
  assert json.loads(state.read_text())['phase']=='submitting'
  if mode=='ambiguous':raise OSError('response lost')
  return type('Call',(),{'object_id':'fc-test'})()
class Call:
 def get(self,timeout):
  calls['poll']+=1
  if mode=='expired':raise SDK.exception.OutputExpiredError('expired')
  return receipt
class Upload:
 def __enter__(self):return self
 def __exit__(self,*args):return False
 def put_file(self,*args,**kwargs):pass
class Volume:
 def batch_upload(self,**kwargs):return Upload()
 def read_file(self,path):
  assert path.endswith('/receipt.json') and mode=='expired'
  return iter([json.dumps(receipt).encode()])
class SDK:
 Function=type('F',(),{'from_name':staticmethod(lambda *a,**k:Function())})
 FunctionCall=type('C',(),{'from_id':staticmethod(lambda *a,**k:Call())})
 Volume=type('V',(),{'from_name':staticmethod(lambda *a,**k:Volume())})
 exception=type('E',(),{'FunctionTimeoutError':type('FunctionTimeoutError',(Exception,),{}),'OutputExpiredError':type('OutputExpiredError',(Exception,),{})})
if mode in ('resume','expired'):state.write_text(json.dumps({'requestHash':'b'*64,'phase':'submitted','call_id':'fc-test'}))
if mode=='pending':state.write_text(json.dumps({'requestHash':'b'*64,'phase':'submitting'}))
try:result=m.run_client(request,state,root,sdk=SDK)
except Exception as e:result={'error':str(e),'needsAttention':getattr(e,'needs_attention',False)}
if mode=='ambiguous':
 try:m.run_client(request,state,root,sdk=SDK)
 except Exception as e:result={'error':str(e),'needsAttention':getattr(e,'needs_attention',False)}
print(json.dumps({'result':result,'calls':calls,'state':json.loads(state.read_text()) if state.exists() else None}))
`;

for(const mode of ['pending','ambiguous','resume','expired']) test(`Python bridge ${mode} preserves durable submission identity`,async()=>{
  const dir=await mkdtemp(join(tmpdir(),'kavion-modal-state-'));
  try{
    const {stdout}=await execute('python3',['-c',pythonRecovery,resolve('scripts/media_modal.py'),dir,mode]);
    const value=JSON.parse(stdout);
    if(mode==='resume'||mode==='expired'){assert.equal(value.calls.spawn,0);assert.equal(value.calls.poll,1);assert.equal(value.result.result.ok,true);}
    else {assert.equal(value.result.needsAttention,true);assert.equal(value.calls.spawn,mode==='ambiguous'?1:0);assert.equal(value.calls.poll,0);}
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('downloads cannot follow a preexisting temporary symlink outside the job',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kavion-modal-download-'));
 try{
  const script=String.raw`
import importlib.util,os,sys,json,hashlib
from pathlib import Path
os.environ['KAVION_MEDIA_CLIENT_MODE']='1'
spec=importlib.util.spec_from_file_location('media_bridge',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path(sys.argv[2]);out=root/'out';out.mkdir();victim=root/'outside.txt';victim.write_text('keep')
(out/'final.mp4.download').symlink_to(victim)
data=b'validated output'
request={'runtimeContract':'astra-v3','runtimeFingerprint':m.runtime_fingerprint(),'schema':1,'operation':'render','jobKey':'a'*64,'requestHash':'b'*64}
receipt={'ok':True,'runtimeContract':'astra-v3','runtimeFingerprint':m.runtime_fingerprint(),'operation':'render','requestHash':'b'*64,'result':{'path':'final.mp4'},'files':[{'path':'final.mp4','size':len(data),'sha256':hashlib.sha256(data).hexdigest()}]}
volume=type('V',(),{'read_file':lambda self,path:iter([data])})()
m.materialize(volume,receipt,request,out)
print(json.dumps({'outside':victim.read_text(),'final':(out/'final.mp4').read_text()}))
`;
  const {stdout}=await execute('python3',['-c',script,resolve('scripts/media_modal.py'),dir]);
  const value=JSON.parse(stdout);assert.equal(value.outside,'keep');assert.equal(value.final,'validated output');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('remote supervisor timeout terminates detached media descendants',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kavion-modal-timeout-'));
 try{
  const script=String.raw`
import importlib.util,os,sys,json,subprocess,time
from pathlib import Path
os.environ['KAVION_MEDIA_CLIENT_MODE']='1'
spec=importlib.util.spec_from_file_location('media_bridge',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path(sys.argv[2]);pidfile=root/'pid'
code="import subprocess,sys,time;from pathlib import Path;p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(20)'],start_new_session=True);Path(sys.argv[1]).write_text(str(p.pid));time.sleep(20)"
with (root/'stdout').open('w') as stdout,(root/'stderr').open('w') as stderr:
 try:m.run_supervised([sys.executable,'-c',code,str(pidfile)],stdout=stdout,stderr=stderr,timeout=.3,cwd=root)
 except subprocess.TimeoutExpired:pass
pid=int(pidfile.read_text());time.sleep(.05)
stat=Path(f'/proc/{pid}/stat');alive=stat.exists() and stat.read_text().rsplit(')',1)[1].split()[0]!='Z'
if alive:os.kill(pid,9)
print(json.dumps({'alive':alive}))
`;
  const {stdout}=await execute('python3',['-c',script,resolve('scripts/media_modal.py'),dir]);
  assert.equal(JSON.parse(stdout).alive,false);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('Astra v3 forwards approved whole-word removals and isolates its request identity',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'astra-remote-cut-'));
 try{
  const source=join(dir,'source.mp4');await writeFile(source,'source');let sent;
  const media=new remote.RemoteMedia({rootDir:resolve('.'),dataDir:dir},{runImpl:async(_cmd,args)=>{sent=JSON.parse(await readFile(args[2],'utf8'));return {stdout:JSON.stringify({ok:true,result:{path:'cut.mp4'}})};}});
  const originalWords=[{text:'Hola',start:0,end:1},{text:'eh',start:1,end:2},{text:'mundo',start:2,end:3}];
  const review={cuts:[{startWord:1,endWord:1,reason:'Arranque fallido.'}]};
  await media.cutVideo(source,[originalWords[0],originalWords[2]],dir,{}, {review,originalWords});
  assert.equal(sent.runtimeContract,'astra-v3');assert.deepEqual(sent.payload.review,review);assert.deepEqual(sent.payload.originalWords,originalWords);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('readiness rejects an old deployment contract and render refuses a missing Astra plan',async()=>{
 const media=new remote.RemoteMedia({rootDir:resolve('.')},{runImpl:async()=>({stdout:JSON.stringify({ok:true,runtimeContract:'sdr-v1'})})});
 await assert.rejects(media.check(),/contrato|runtime/i);
 await assert.rejects(media.renderVideo({source:'missing.mp4',words:[{text:'Hola',start:0,end:1}],duration:1,width:1080,height:1920,dir:'/tmp'}),/Astra|plan/i);
});

test('remote function identity binds the complete current compiler and rejects legacy wire contracts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'astra-runtime-contract-'));
 try{
  const script=String.raw`
import importlib.util,os,sys,json,shutil
from pathlib import Path
os.environ['KAVION_MEDIA_CLIENT_MODE']='1'
spec=importlib.util.spec_from_file_location('bridge',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path(sys.argv[2])
for name in m.RUNTIME_FILES:
 p=root/name;p.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(m.ROOT/name,p)
m.ROOT=root
before=m.runtime_function_name()
with (root/'src/edit-plan.mjs').open('a') as f:f.write('\n// fixture change\n')
after=m.runtime_function_name()
try:m.namespace_for({'schema':1,'operation':'smoke','jobKey':'a'*64,'requestHash':'b'*64});rejected=False
except ValueError:rejected=True
print(json.dumps({'before':before,'after':after,'rejected':rejected}))
`;
  const {stdout}=await execute('python3',['-c',script,resolve('scripts/media_modal.py'),dir]);const result=JSON.parse(stdout);
  assert.notEqual(result.before,result.after);assert.match(result.before,/^run_media_astra_v3_/);assert.equal(result.rejected,true);
  const imported=await execute(process.execPath,['--input-type=module','-e',`const m=await import(${JSON.stringify(join(dir,'src/composition.mjs'))});console.log(typeof m.renderVideo)`]);
  assert.equal(imported.stdout.trim(),'function');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('request identity includes compiler fingerprint and rejects a receipt from another runtime',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'astra-fingerprint-'));
 try{
  const source=join(dir,'source.mp4');await writeFile(source,'source');let request;
  const media=new remote.RemoteMedia({rootDir:resolve('.'),dataDir:dir},{runImpl:async(_cmd,args)=>{request=JSON.parse(await readFile(args[2],'utf8'));return {stdout:JSON.stringify({ok:true,result:{path:'cut.mp4'},receipt:{runtimeContract:'astra-v3',runtimeFingerprint:'f'.repeat(64)}})};}});
  await assert.rejects(media.cutVideo(source,[{text:'Hola',start:0,end:1}],dir),/huella|runtime/i);
  assert.match(request.runtimeFingerprint,/^[a-f0-9]{64}$/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('compiler changes invalidate request hashes and cannot overwrite a submitted operation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'astra-runtime-change-'));
 try{
  const manifest=JSON.parse(await readFile('scripts/media-runtime.json','utf8'));
  for(const name of manifest.files){await fs.promises.mkdir(join(dir,name,'..'),{recursive:true});await fs.promises.copyFile(resolve(name),join(dir,name));}
  const source=join(dir,'source.mp4');await writeFile(source,'source');const requests=[];
  const media=new remote.RemoteMedia({rootDir:dir,dataDir:dir},{runImpl:async(_cmd,args)=>{requests.push(JSON.parse(await readFile(args[2],'utf8')));return {stdout:JSON.stringify({ok:true,result:{path:'cut.mp4'}})};}});
  const words=[{text:'Hola',start:0,end:1}];await media.cutVideo(source,words,dir);
  await fs.promises.appendFile(join(dir,'src/edit-plan.mjs'),'\n// compiler revision\n');
  await media.cutVideo(source,words,dir);
  assert.notEqual(requests[0].requestHash,requests[1].requestHash);assert.notEqual(requests[0].runtimeFingerprint,requests[1].runtimeFingerprint);
  const statePath=join(dir,'.remote-media/cut/state.json');await writeFile(statePath,JSON.stringify({requestHash:requests[1].requestHash,call_id:'fc-preserved'}));
  await fs.promises.appendFile(join(dir,'src/edit-plan.mjs'),'\n// another revision\n');
  await assert.rejects(media.cutVideo(source,words,dir),e=>e.needsAttention===true);
  assert.equal(JSON.parse(await readFile(statePath,'utf8')).call_id,'fc-preserved');
  assert.equal(JSON.parse(await readFile(join(dir,'.remote-media/cut/request.json'),'utf8')).requestHash,requests[1].requestHash);
 }finally{await rm(dir,{recursive:true,force:true});}
});


test('voice reference upload is separate, content-addressed, and optional without changing render expectations',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'astra-voice-upload-'));
 try{
  const final=join(dir,'final.mp4'),voice=join(dir,'cut.mp4');
  await writeFile(final,'mixed final');await writeFile(voice,'original cut voice');
  const requests=[];
  const media=new remote.RemoteMedia({rootDir:resolve('.'),dataDir:dir},{runImpl:async(_cmd,args)=>{
   requests.push(JSON.parse(await readFile(args[2],'utf8')));
   return {stdout:JSON.stringify({ok:true,result:{ok:true}})};
  }});
  const expected={expectedDuration:3,expectedWidth:1080,expectedHeight:1920,expectedWordEnd:2.9};
  await media.verifyVideo(final,{...expected,voiceReferencePath:voice});
  const first=requests.at(-1);
  assert.deepEqual(first.inputs.map(input=>input.name),['source.mp4','voice-reference.mp4']);
  assert.equal(first.inputs[1].path,voice);
  assert.deepEqual(first.payload,{maxSilence:.3,...expected,voiceReference:true});
  await writeFile(voice,'revised original voice');
  await media.verifyVideo(final,{...expected,voiceReferencePath:voice});
  assert.notEqual(first.requestHash,requests.at(-1).requestHash,'voice evidence must bind the durable verification identity');
  await media.verifyVideo(final,expected);
  assert.deepEqual(requests.at(-1).inputs.map(input=>input.name),['source.mp4']);
  assert.deepEqual(requests.at(-1).payload,{maxSilence:.3,...expected});
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('remote worker verifies the rendered video with a separate local voice reference',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'astra-worker-voice-'));
 try{
  await fs.promises.mkdir(join(dir,'scripts'));await fs.promises.mkdir(join(dir,'src'));
  await fs.promises.copyFile(resolve('scripts/media-remote.mjs'),join(dir,'scripts/media-remote.mjs'));
  // Avoid rendering or process execution: inspect the worker boundary into the real verifier API.
  await writeFile(join(dir,'src/media.mjs'),`export const cutVideo=()=>{},runMediaCommand=()=>{};export const verifyVideo=async(path,config)=>({inspectedPath:path,config});`);
  await writeFile(join(dir,'src/composition.mjs'),`export const renderVideo=()=>{};`);
  const control=join(dir,'request.json'),out=join(dir,'outputs');
  for(const voiceReference of [true,false]){
   await writeFile(control,JSON.stringify({runtimeContract:'astra-v3',operation:'verify',payload:{voiceReference,maxSilence:.3,expectedDuration:8,expectedWidth:1080,expectedHeight:1920,expectedWordEnd:7.9}}));
   await execute(process.execPath,[join(dir,'scripts/media-remote.mjs'),control,out]);
   const result=JSON.parse(await readFile(join(out,'result.json'),'utf8'));
   assert.equal(result.inspectedPath,join(dir,'inputs/source.mp4'));
   assert.equal(result.config.voiceReferencePath,voiceReference?join(dir,'inputs/voice-reference.mp4'):undefined);
   assert.equal(result.config.expectedDuration,8);assert.equal(result.config.expectedWidth,1080);assert.equal(result.config.expectedWordEnd,7.9);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('changing any reference renderer font or sound changes the immutable runtime fingerprint',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'astra-reference-bundle-'));
 try{
  const manifest=JSON.parse(await readFile('scripts/media-runtime.json','utf8'));
  for(const name of manifest.files){await fs.promises.mkdir(join(dir,name,'..'),{recursive:true});await fs.promises.copyFile(resolve(name),join(dir,name));}
  const files=['src/reference-composition.mjs','public/fonts/LiberationSans-Bold.ttf','public/fonts/LiberationSerif-Italic.ttf','assets/sfx/whoosh-short.mp3','assets/sfx/click-soft.mp3','assets/sfx/impact-bass-1.mp3'];
  for(const name of files){await fs.promises.mkdir(join(dir,name,'..'),{recursive:true});await writeFile(join(dir,name),'original fixture');}
  for(const name of files){
   const before=await remote.mediaRuntimeFingerprint(dir);
   await fs.promises.appendFile(join(dir,name),' changed bytes');
   assert.notEqual(await remote.mediaRuntimeFingerprint(dir),before,`${name} must invalidate stale remote code and receipts`);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('remote frames bind bounded timestamps and return only confined local sheet paths',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'astra-remote-frames-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=join(dir,'source.mp4');await writeFile(source,'synthetic');const requests=[];let images=['sheet-0.jpg'];
 const media=new remote.RemoteMedia({rootDir:resolve('.'),dataDir:dir},{runImpl:async(_cmd,args)=>{
  requests.push(JSON.parse(await readFile(args[2],'utf8')));return {stdout:JSON.stringify({ok:true,result:{images}})};
 }});
 assert.deepEqual(await media.frames(source,[0,.5],dir),{images:[join(dir,'sheet-0.jpg')]});
 assert.equal(requests[0].operation,'frames');assert.deepEqual(requests[0].payload,{times:[0,.5]});assert.equal(requests[0].inputs[0].name,'source.mp4');
 await media.frames(source,[0,.6],dir);assert.notEqual(requests[0].requestHash,requests[1].requestHash);
 for(const times of [[],Array(25).fill(0),[-.1],[NaN],[Infinity],['1']])await assert.rejects(media.frames(source,times,dir),/tiempos|cuadros/i);
 assert.equal(requests.length,2,'invalid timestamp requests must not submit');
 images=['../outside.jpg'];await assert.rejects(media.frames(source,[0],dir),/ruta/i);
});

test('remote frames worker checks source duration before extraction and disables remote recursion',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'astra-worker-frames-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await fs.promises.mkdir(join(dir,'scripts'));await fs.promises.mkdir(join(dir,'src'));
 await fs.promises.copyFile(resolve('scripts/media-remote.mjs'),join(dir,'scripts/media-remote.mjs'));
 await writeFile(join(dir,'src/media.mjs'),`export const cutVideo=()=>{},verifyVideo=()=>{},runMediaCommand=()=>{};export const probe=async()=>({duration:2});`);
 await writeFile(join(dir,'src/composition.mjs'),`export const renderVideo=()=>{};`);
 await writeFile(join(dir,'src/visual-context.mjs'),`import {writeFile} from 'node:fs/promises';import {join} from 'node:path';export async function extractVisualSheets(source,times,dir,config){await writeFile(join(dir,'extraction.json'),JSON.stringify({source,times,config}));return [join(dir,'sheet-0.jpg')];}`);
 const control=join(dir,'request.json'),out=join(dir,'outputs');
 await writeFile(control,JSON.stringify({runtimeContract:'astra-v3',operation:'frames',payload:{times:[0,1.99]}}));
 await execute(process.execPath,[join(dir,'scripts/media-remote.mjs'),control,out]);
 assert.deepEqual(JSON.parse(await readFile(join(out,'result.json'),'utf8')),{images:['sheet-0.jpg']});
 const extracted=JSON.parse(await readFile(join(out,'extraction.json'),'utf8'));
 assert.equal(extracted.source,join(dir,'inputs/source.mp4'));assert.deepEqual(extracted.times,[0,1.99]);assert.equal(extracted.config.visualFramesRemote,false);
 await rm(join(out,'extraction.json'));
 for(const times of [[2],[-.1],[],Array(25).fill(0),['1']]){
  await writeFile(control,JSON.stringify({runtimeContract:'astra-v3',operation:'frames',payload:{times}}));
  await assert.rejects(execute(process.execPath,[join(dir,'scripts/media-remote.mjs'),control,out]),/frame|time/i);
 }
 await assert.rejects(readFile(join(out,'extraction.json')),{code:'ENOENT'});
});

test('Python frame operation collects sheet images but excludes intermediate frames',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'astra-python-frames-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const script=String.raw`
import importlib.util,os,sys,json
from pathlib import Path
os.environ['KAVION_MEDIA_CLIENT_MODE']='1'
spec=importlib.util.spec_from_file_location('bridge',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path(sys.argv[2]);request={'runtimeContract':'astra-v3','runtimeFingerprint':m.runtime_fingerprint(),'schema':1,'operation':'frames','jobKey':'a'*64,'requestHash':'b'*64,'payload':{'times':[0]},'inputs':[]}
namespace=m.namespace_for(request);control=f'/{namespace}/request.json';job=root/namespace;job.mkdir(parents=True);(job/'request.json').write_text(json.dumps(request))
realpath=Path
m.Path=lambda value:root/str(value).removeprefix('/media/') if str(value).startswith('/media/') else realpath(value)
m.MEDIA_VOLUME=type('Volume',(),{'reload':lambda self:None,'commit':lambda self:None})()
def run(*args,**kwargs):
 out=job/'outputs';(out/'sheet-0.jpg').write_bytes(b'image');(out/'page-0').mkdir();(out/'page-0'/'frame-00.jpg').write_bytes(b'intermediate');(out/'result.json').write_text(json.dumps({'images':['sheet-0.jpg']}));return type('Done',(),{'returncode':0})()
m.run_supervised=run
receipt=m.remote_run(control,'b'*64)
print(json.dumps(receipt))
`;
 const {stdout}=await execute('python3',['-c',script,resolve('scripts/media_modal.py'),dir]);const receipt=JSON.parse(stdout);
 assert.equal(receipt.ok,true,receipt.error);assert.ok(receipt.files.some(file=>file.path==='sheet-0.jpg'));assert.ok(!receipt.files.some(file=>file.path.includes('frame-00')));
});
