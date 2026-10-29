import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat,readdir,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {loadConfig} from '../src/config.mjs';
import {Store} from '../src/store.mjs';
import {createApp} from '../src/app.mjs';
import {runMediaCommand} from '../src/media.mjs';

async function fixture(t,extra={}){
 const dir=await mkdtemp(join(tmpdir(),'kavion-upload-'));
 const store=new Store(join(dir,'queue.sqlite'));
 const config={...loadConfig({DATA_DIR:dir}),baseUrl:'http://127.0.0.1',dataDir:dir,publicDir:join(dir,'public'),maxInputBytes:2*1024**3,maxVideoDuration:600,...extra};
 const app=createApp({store,config,integrationStatus:async()=>[]});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}`;config.baseUrl=base;
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));store.close();await rm(dir,{recursive:true,force:true});});
 const response=await fetch(base+'/api/status'),s=await response.json();
 const headers={'cookie':response.headers.get('set-cookie').split(';')[0],origin:base,'x-csrf-token':s.csrfToken,'content-type':'application/octet-stream','idempotency-key':'upload-test','x-video-filename':encodeURIComponent('Video prueba.MOV')};
 const send=(body,overrides={})=>fetch(base+'/api/jobs/upload',{method:'POST',headers:{...headers,...overrides},body});
 const media=async(ext='mov',options=[])=>{
  const file=join(dir,'fixture.'+ext);
  await runMediaCommand(config.ffmpegPath,['-v','error','-y','-f','lavfi','-i','color=c=blue:s=64x96:d=0.3','-f','lavfi','-i','sine=frequency=440:duration=0.3',...options,...(ext==='webm'?['-c:v','libvpx-vp9','-c:a','libopus']:['mpg','mpeg','mts','m2ts'].includes(ext)?['-c:v','mpeg2video','-c:a','mp2','-f',['mts','m2ts'].includes(ext)?'mpegts':'mpeg']:['-c:v','mpeg4','-c:a','aac',...(ext==='m4v'?['-f','mp4']:[])]),'-shortest',file]);
  return readFile(file);
 };
 return {dir,store,config,base,headers,send,media};
}

test('MOV upload creates one private durable source and an idempotent queued job',async t=>{
 const f=await fixture(t),bytes=await f.media();
 const r=await f.send(bytes);assert.equal(r.status,201);const publicJob=await r.json();
 assert.equal(publicJob.sourceType,'upload');assert.equal(publicJob.sourceName,'Video prueba.MOV');assert.equal(publicJob.status,'queued');assert.equal(publicJob.sourceUrl,null);assert.equal(publicJob.artifacts,undefined);
 const job=f.store.getJob(publicJob.id),source=job.artifacts.source;
 assert.deepEqual(await readFile(source.path),bytes);assert.equal((await stat(source.path)).mode&0o777,0o600);
 assert.ok(source.path.startsWith(join(f.dir,'jobs',job.id)));assert.match(source.sha256,/^[a-f0-9]{64}$/);
 const again=await f.send(bytes);assert.equal(again.status,200);assert.equal((await again.json()).id,job.id);assert.equal(f.store.listJobs().length,1);
 const changed=await f.send(Buffer.concat([bytes,Buffer.from('changed')]));assert.equal(changed.status,409);
 const renamed=await f.send(bytes,{'x-video-filename':'other.mov'});assert.equal(renamed.status,409);
 assert.deepEqual(await readdir(join(f.dir,'jobs')),[job.id]);
 const reopened=new Store(join(f.dir,'queue.sqlite'));assert.equal(reopened.claimJob().artifacts.source.sha256,source.sha256);reopened.close();
});

test('all advertised video containers enter the same upload queue',async t=>{
 const f=await fixture(t);
 for(const ext of ['mp4','m4v','mkv','webm','avi','mpg','mpeg','mts','m2ts']){
  const response=await f.send(await f.media(ext),{'x-video-filename':'video.'+ext,'idempotency-key':'container-'+ext});
  assert.equal(response.status,201,ext+': '+await response.text());
 }
 assert.equal(f.store.listJobs().length,9);
});

test('upload rejects corrupt, empty, oversized, overlong and voiceless media before queueing',async t=>{
 const f=await fixture(t,{maxInputBytes:200000});
 assert.equal((await f.send(Buffer.from('not a video'))).status,422);
 assert.equal((await f.send(Buffer.alloc(0))).status,400);
 assert.equal((await f.send(Buffer.alloc(200001))).status,413);
 const bytes=await f.media();f.config.maxVideoDuration=.1;
 assert.equal((await f.send(bytes)).status,422);f.config.maxVideoDuration=600;
 const silent=await f.media('mov',['-an']);assert.equal((await f.send(silent)).status,422);
 assert.equal(f.store.listJobs().length,0);assert.deepEqual(await readdir(join(f.dir,'jobs')),[]);
});

test('uploads enforce CSRF, filename confinement and binary request type',async t=>{
 const f=await fixture(t),bytes=Buffer.from('body');
 for(const headers of [{'x-csrf-token':'bad'},{origin:'https://evil.example'}])assert.equal((await f.send(bytes,headers)).status,403);
 for(const name of ['../video.mov','C:\\video.mov','video.exe','bad\u0000.mov','%broken']){
  assert.equal((await f.send(bytes,{'x-video-filename':name==='%broken'?name:encodeURIComponent(name)})).status,400,name);
 }
 assert.equal((await f.send(bytes,{'content-type':'text/plain'})).status,415);
 assert.equal(f.store.listJobs().length,0);
});

test('aborted and simultaneous transfers leave no queued partial video',async t=>{
 const f=await fixture(t),url=new URL(f.base+'/api/jobs/upload');
 const first=httpRequest(url,{method:'POST',headers:{...f.headers,'content-length':10000}});first.on('error',()=>{});first.write(Buffer.alloc(20));
 for(let i=0;i<100;i++){
  let entries=[];try{entries=await readdir(join(f.dir,'jobs'));}catch{}
  if(entries.length)break;await new Promise(r=>setTimeout(r,10));
 }
 assert.equal((await f.send(Buffer.from('duplicate'))).status,409);
 first.destroy();
 for(let i=0;i<100;i++){if(!(await readdir(join(f.dir,'jobs'))).length)break;await new Promise(r=>setTimeout(r,10));}
 assert.deepEqual(await readdir(join(f.dir,'jobs')),[]);assert.equal(f.store.listJobs().length,0);
});

test('upload refuses a symlinked jobs root and cannot alias a Drive job key',async t=>{
 const f=await fixture(t),outside=join(f.dir,'outside');await mkdir(outside);await symlink(outside,join(f.dir,'jobs'));
 const response=await f.send(Buffer.from('body'));assert.equal(response.status,409);assert.deepEqual(await readdir(outside),[]);
 await rm(join(f.dir,'jobs'));f.store.createJob({sourceUrl:'https://drive.google.com/file/d/abcdefghijk/view',idempotencyKey:'upload-test'});
 const conflict=await f.send(await f.media());assert.equal(conflict.status,409);assert.equal(f.store.listJobs().length,1);
});

test('a renamed playlist cannot make upload validation fetch another URL',async t=>{
 const f=await fixture(t);let requests=0;
 const {createServer}=await import('node:http');const remote=createServer((_,res)=>{requests++;res.end('not media');});
 remote.listen(0,'127.0.0.1');await new Promise(r=>remote.once('listening',r));
 try{
  const body=Buffer.from(`#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:${remote.address().port}/private.ts\n#EXT-X-ENDLIST\n`);
  assert.equal((await f.send(body)).status,422);assert.equal(requests,0);
 }finally{await new Promise(r=>remote.close(r));}
});

test('a truncated MOV with readable metadata is rejected before entering the paid pipeline',async t=>{
 const f=await fixture(t),file=join(f.dir,'faststart.mov');
 await runMediaCommand(f.config.ffmpegPath,['-v','error','-y','-f','lavfi','-i','testsrc2=s=128x192:d=3','-f','lavfi','-i','sine=frequency=440:duration=3','-c:v','mpeg4','-q:v','3','-c:a','aac','-movflags','+faststart','-shortest',file]);
 const bytes=await readFile(file),truncated=bytes.subarray(0,Math.floor(bytes.length/2));
 const r=await f.send(truncated);assert.equal(r.status,422);assert.equal(f.store.listJobs().length,0);assert.deepEqual(await readdir(join(f.dir,'jobs')),[]);
});

test('overlapping uploads reserve shared disk capacity and release each reservation only once',async()=>{
 const {createUploadReservations}=await import('../src/uploads.mjs');assert.equal(typeof createUploadReservations,'function');
 const reserve=createUploadReservations({freeBytes:async()=>7n*1024n**3n/2n});
 const results=await Promise.allSettled([reserve('/disk',2*1024**3),reserve('/disk',2*1024**3)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.find(r=>r.status==='rejected').reason.status,507);
 const release=results.find(r=>r.status==='fulfilled').value;release();release();
 const next=await reserve('/disk',2*1024**3);
 await assert.rejects(()=>reserve('/disk',2*1024**3),e=>e.status===507);next();
});
