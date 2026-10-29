import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';
test('expired database lease cannot start a second live worker',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'kavion-lock-'));const env={...process.env,DATA_DIR:dir};
 const first=spawn(process.execPath,['src/worker.mjs'],{env,stdio:['ignore','pipe','pipe']});let second;
 try{
  await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('worker did not start')),10000);first.stdout.on('data',b=>{if(String(b).includes('Worker iniciado')){clearTimeout(t);resolve();}});first.on('exit',code=>{clearTimeout(t);reject(new Error(`first worker exited ${code}`));});});
  const db=new DatabaseSync(path.join(dir,'studio.sqlite'));db.prepare('UPDATE worker_lease SET expires=0').run();db.close();
  second=spawn(process.execPath,['src/worker.mjs'],{env,stdio:'ignore'});
  const result=await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('duplicate worker remained active')),3000);second.on('exit',code=>{clearTimeout(t);resolve(code);});});assert.equal(result,1);
 }finally{second?.kill('SIGTERM');first.kill('SIGTERM');await new Promise(r=>{if(first.exitCode!==null)return r();first.on('exit',r);setTimeout(r,7000).unref();});await rm(dir,{recursive:true,force:true});}
});
