import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,symlink,access,rm,chmod} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {cleanupCompleted} from '../src/retention.mjs';
test('retention removes only expired completed media and preserves failed work and metadata',async()=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'kavion-clean-'));const now=Date.now();
 for(const id of ['done','failed']){await mkdir(path.join(dataDir,'jobs',id),{recursive:true});for(const file of ['source.mp4','transcript.json'])await writeFile(path.join(dataDir,'jobs',id,file),'fixture');}
 const outside=path.join(dataDir,'outside.mp4');await writeFile(outside,'source');await symlink(outside,path.join(dataDir,'jobs/done/link.mp4'));
 const jobs=['done','failed'].map(id=>({id,status:id==='done'?'completed':'failed',updatedAt:new Date(now-31*86400000).toISOString(),result:{fileId:'remote'},artifacts:{verification:{ok:true}}}));
 await cleanupCompleted({listJobs:()=>jobs,updateJob:()=>{}},{dataDir},{now});
 await assert.rejects(access(path.join(dataDir,'jobs/done/source.mp4')));await access(path.join(dataDir,'jobs/done/transcript.json'));await access(path.join(dataDir,'jobs/failed/source.mp4'));await access(outside);await rm(dataDir,{recursive:true});
});
test('retention skips inaccessible archived directories and continues cleanup',async()=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'kavion-clean-errors-'));const now=Date.now();const warnings=[];
 const blocked=path.join(dataDir,'jobs/blocked');const good=path.join(dataDir,'jobs/good');
 try{
  for(const dir of [blocked,good]){await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'source.mp4'),'fixture');}
  await chmod(blocked,0);
  const jobs=['blocked','good'].map(id=>({id,status:'completed',updatedAt:new Date(now-31*86400000).toISOString(),result:{fileId:'remote'},artifacts:{verification:{ok:true}}}));
  const result=await cleanupCompleted({listJobs:()=>jobs},{dataDir},{now,onWarning:message=>warnings.push(message)});
  assert.equal(result.removed,1);assert.equal(warnings.length,1);await assert.rejects(access(path.join(good,'source.mp4')));
 }finally{await chmod(blocked,0o700).catch(()=>{});await rm(dataDir,{recursive:true,force:true});}
});
test('retention removes abandoned remote downloads after seven days only for verified completed jobs',async()=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'kavion-clean-download-'));const now=Date.now();
 const jobs=[
  {id:'expired',status:'completed',days:7,ok:true},
  {id:'recent',status:'completed',days:6,ok:true},
  {id:'failed',status:'failed',days:31,ok:true},
  {id:'unverified',status:'completed',days:31,ok:false},
 ];
 try{
  for(const job of jobs){
   const dir=path.join(dataDir,'jobs',job.id);await mkdir(path.join(dir,'composition/assets'),{recursive:true});
   for(const file of ['.final.mp4.abcdefgh.download','composition/assets/.source.mp4.ijklmnop.download','final.mp4','state.json','notes.download'])await writeFile(path.join(dir,file),'keep unless expired partial');
  }
  const outside=path.join(dataDir,'outside.mp4');await writeFile(outside,'keep');
  await symlink(outside,path.join(dataDir,'jobs/expired/.final.mp4.symlink.download'));
  const records=jobs.map(job=>({...job,updatedAt:new Date(now-job.days*86400000).toISOString(),result:{fileId:'remote'},artifacts:{verification:{ok:job.ok}}}));
  const result=await cleanupCompleted({listJobs:()=>records},{dataDir},{now});
  assert.equal(result.removed,2);
  for(const job of jobs){
   const dir=path.join(dataDir,'jobs',job.id);
   for(const file of ['.final.mp4.abcdefgh.download','composition/assets/.source.mp4.ijklmnop.download']){
    if(job.id==='expired')await assert.rejects(access(path.join(dir,file)),{code:'ENOENT'});
    else await access(path.join(dir,file));
   }
   for(const file of ['final.mp4','state.json','notes.download'])await access(path.join(dir,file));
  }
  await access(outside);await access(path.join(dataDir,'jobs/expired/.final.mp4.symlink.download'));
 }finally{await rm(dataDir,{recursive:true,force:true});}
});
