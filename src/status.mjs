import {existsSync,readFileSync} from 'node:fs';
import {run} from './process.mjs';
import {AstraClient} from './providers/astra.mjs';
import {LocalTranscriber} from './local-transcription.mjs';
import {ModalTranscriber} from './modal-transcription.mjs';
import {RemoteMedia} from './remote-media.mjs';
export function availableMemoryMb(){try{return Number(readFileSync('/proc/meminfo','utf8').match(/MemAvailable:\s+(\d+)/)?.[1]||0)/1024;}catch{return Infinity;}}
export function mediaMemoryFloor(config={}){return config.mediaBackend==='modal'?256:768;}
export function makeStatus({config,store,drive,higgs,runImpl=run,memory=availableMemoryMb,astra=new AstraClient(config),transcriber,remoteMedia}){
 const remote=config.mediaBackend==='modal';
 transcriber??=remote?new ModalTranscriber(config):new LocalTranscriber(config);
 if(remote)remoteMedia??=new RemoteMedia(config);
 const names={drive:'Google Drive',higgsfield:'Higgsfield',editorial:'Astra High',transcription:remote?'Transcripción en Modal':'Transcripción local',render:remote?'HyperFrames en Modal':'HyperFrames local',resources:'Capacidad del equipo'};
 let cached=Object.entries(names).map(([id,name])=>({id,name,state:'missing',detail:'Comprobando conexión…'})),at=0,pending;
 const inFlight=new Map();
 const inspect=async(id,fn)=>{
  if(!inFlight.has(id))inFlight.set(id,Promise.resolve().then(fn).finally(()=>inFlight.delete(id)));
  let timer;try{return {id,name:names[id],...await Promise.race([inFlight.get(id),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('La conexión está tardando. Podés seguir usando el panel.')),8000);timer.unref();})])};}
  catch(e){return {id,name:names[id],state:'error',detail:e.message};}finally{clearTimeout(timer);}
 };
 const check=async()=>Promise.all([
  inspect('drive',async()=>{const result=await drive.check();return {...result,actionUrl:result.state==='missing'&&drive.configured()?'/api/auth/google':undefined};}),
  inspect('higgsfield',async()=>{const w=await higgs.check();return {state:'ready',detail:`${w.credits} créditos disponibles.`};}),
  inspect('editorial',async()=>{const result=await astra.check();return {state:result.ready?'ready':'missing',detail:result.ready?'Astra High conectado mediante tu sesión de Codex.':result.reason||'Falta conectar Astra High en este equipo.'};}),
  inspect('transcription',async()=>{const result=await transcriber.check();return !remote&&result.state==='missing'?{state:'missing',detail:'Falta preparar la transcripción local en el equipo de edición.'}:result;}),
  inspect('render',async()=>{if(remoteMedia)return remoteMedia.check();await runImpl(config.ffmpegPath,['-version'],{timeout:7000});await runImpl(config.ffprobePath,['-version'],{timeout:7000});return config.hyperframesPath&&existsSync(config.hyperframesPath)?{state:'ready',detail:'HyperFrames y FFmpeg instalados para render local.'}:{state:'missing',detail:'Faltan herramientas de renderizado local.'};}),
  inspect('resources',async()=>memory()>=mediaMemoryFloor(config)?{state:'ready',detail:remote?'Servidor disponible; la transcripción, los cortes y el render se procesan en Modal.':'Capacidad disponible para un trabajo; la transcripción comprueba su memoria por separado.'}:{state:'waiting',detail:'La memoria disponible es baja. El worker esperará antes de procesar.'}),
 ]);
 return async({fresh=false}={})=>{
  if(fresh||!at||Date.now()-at>30000){if(!pending)pending=check().then(x=>{cached=x;at=Date.now();return x;}).finally(()=>pending=null);if(fresh)await pending;}
  const worker=store.workerStatus(),settings=store.getSettings();
  return {ready:Boolean(settings.destinationFolderId)&&cached.every(x=>x.state==='ready')&&worker.online&&settings.maxCreditsPerVideo!=null,worker,integrations:cached,destination:{id:settings.destinationFolderId,name:'Carpeta de salida',url:settings.destinationFolderId?`https://drive.google.com/drive/folders/${settings.destinationFolderId}`:null}};
 };
}
