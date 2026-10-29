process.umask(0o077);
import path from 'node:path';import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {loadConfig} from './config.mjs';import {Store} from './store.mjs';
import {DriveClient} from './providers/drive.mjs';import {HiggsfieldClient} from './providers/higgsfield.mjs';import {EditorialClient} from './providers/editorial.mjs';
import {RemoteMedia} from './remote-media.mjs';import {ModalTranscriber} from './modal-transcription.mjs';
import {makeStatus,availableMemoryMb,mediaMemoryFloor} from './status.mjs';import {processJob} from './pipeline.mjs';
import {cleanupCompleted} from './retention.mjs';
import {jobPreflight} from './preflight.mjs';
const config=loadConfig();
// Kernel lifetime lock survives SIGSTOP and prevents lease-expiry takeover.
if(!process.argv.includes('--lock-held')){
 const child=spawn('flock',['--nonblock','--no-fork',path.join(config.dataDir,'worker.lock'),process.execPath,process.argv[1],'--lock-held'],{stdio:'inherit'});
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
 child.on('error',()=>{console.error('No se pudo obtener el bloqueo del worker (flock).');process.exit(1);});
 child.on('exit',code=>process.exit(code??1));
 await new Promise(()=>{});
}
const dbFile=path.join(config.dataDir,'studio.sqlite'),store=new Store(dbFile,{destinationFolderId:config.destinationFolderId});
const leaseDb=new DatabaseSync(dbFile);leaseDb.exec('CREATE TABLE IF NOT EXISTS worker_lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, expires INTEGER)');
const owner=randomUUID();
const acquire=()=>leaseDb.prepare('INSERT INTO worker_lease(id,owner,expires) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE worker_lease.expires < ? OR worker_lease.owner = ?').run(owner,Date.now()+60000,Date.now(),owner).changes>0;
if(!acquire()){console.error('Ya hay un worker activo.');process.exit(1);}
let stopping=false;let leaseLost=false;
const beat=setInterval(()=>{try{if(!acquire()){leaseLost=true;stopping=true;}else store.heartbeat();}catch{leaseLost=true;stopping=true;}},10000);store.heartbeat();
process.on('SIGTERM',()=>stopping=true);process.on('SIGINT',()=>stopping=true);
const drive=new DriveClient(config),higgs=new HiggsfieldClient(config),transcriber=new ModalTranscriber(config),editorial=new EditorialClient(config,{transcriber});
const media=new RemoteMedia(config);
const status=makeStatus({config,store,drive,higgs,transcriber,remoteMedia:media});
const assertLease=()=>{const l=leaseDb.prepare('SELECT owner,expires FROM worker_lease WHERE id=1').get();if(leaseLost||l?.owner!==owner||l.expires<Date.now())throw new Error('Se perdió la reserva del worker.');};
const context={config,store,drive,higgs,editorial,media,assertLease,preflight:async a=>{assertLease();return jobPreflight(await status({fresh:true}),a);}};
console.log('Worker iniciado. Los trabajos se guardan aunque cierres la página.');
let lastCleanup=0;
try{
 while(!stopping){
  if(Date.now()-lastCleanup>3600000){
   try{await cleanupCompleted(store,config);}catch(error){console.warn(`No se completó la limpieza de archivos: ${error.code||'error de mantenimiento'}. La cola continúa.`);}
   lastCleanup=Date.now();
  }
  if(availableMemoryMb()<mediaMemoryFloor(config)){await new Promise(r=>setTimeout(r,5000));continue;}
  const running=store.listJobs().find(j=>j.status==='running');const job=running||store.claimJob();
  if(job)await processJob(job,context);else await new Promise(r=>setTimeout(r,2000));
 }
}finally{clearInterval(beat);leaseDb.prepare('DELETE FROM worker_lease WHERE id=1 AND owner=?').run(owner);leaseDb.close();store.close();}
