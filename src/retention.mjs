import {readdir,unlink,realpath} from 'node:fs/promises';import path from 'node:path';
export async function cleanupCompleted(store,config,{now=Date.now(),onWarning=console.warn}={}){
 const root=await realpath(config.dataDir);let removed=0;
 for(const job of store.listJobs()){
  if(job.status!=='completed'||!job.result?.fileId||!job.artifacts?.verification?.ok)continue;
  const age=now-Date.parse(job.updatedAt);if(!Number.isFinite(age)||age<7*86400000)continue;
  const intended=path.join(root,'jobs',job.id);let actual;try{actual=await realpath(intended);}catch{continue;}
  if(actual!==intended||!actual.startsWith(root+path.sep))continue;
  const warn=error=>onWarning(`Limpieza omitida para ${job.id}: ${error.code||'error de archivo'}.`);
  const walk=async dir=>{let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch(error){warn(error);return;}for(const entry of entries){
   const file=path.join(dir,entry.name);if(entry.isSymbolicLink())continue;
   if(entry.isDirectory()){await walk(file);continue;}
   if(!entry.isFile())continue;
   const partialDownload=/^\..+\.[A-Za-z0-9_-]+\.download$/.test(entry.name);
   if(!partialDownload&&!/\.(mp4|mov|mkv|webm|wav|m4a)$/i.test(entry.name))continue;
   if(age<30*86400000&&!partialDownload&&!/\b(pending|temp)\b/.test(entry.name))continue;
   try{await unlink(file);removed++;}catch(error){warn(error);}
  }};
  await walk(actual);
 }
 return {removed};
}
