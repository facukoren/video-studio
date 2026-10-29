import {createHash,randomUUID} from 'node:crypto';
import {constants,createReadStream} from 'node:fs';
import {open,mkdir,lstat,realpath,rename,rm} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {run} from './process.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const VERSION=1,MAX_JSON=16*1024**2;
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const digest=value=>createHash('sha256').update(value).digest('hex');
const attention=message=>Object.assign(new Error(message),{needsAttention:true});
async function privateDir(dir){
 await mkdir(dir,{recursive:true,mode:0o700});
 const info=await lstat(dir);if(info.isSymbolicLink()||!info.isDirectory())throw attention('El directorio de transcripción no puede ser un enlace.');
 return realpath(dir);
}
async function privateRead(file){
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const info=await handle.stat();if(!info.isFile()||info.size>MAX_JSON)throw attention('El resultado de transcripción no es válido.');return await handle.readFile();}finally{await handle.close();}
}
async function atomicJson(file,value){
 const temporary=`${file}.${randomUUID()}.tmp`;
 const handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}
 try{await rename(temporary,file);}finally{await rm(temporary,{force:true});}
}
function normalize(words,maxDuration=600){
 if(!Array.isArray(words)||!words.length||words.length>10000)throw attention('La transcripción no devolvió palabras válidas.');
 let end=0;
 return words.map(word=>{
  if(typeof word?.text!=='string'||!word.text.trim()||word.text.length>2000||!Number.isFinite(word.start)||!Number.isFinite(word.end)||word.start<end-1e-8||word.end<=word.start||word.end>maxDuration+.04)throw attention('La transcripción contiene tiempos inválidos o palabras superpuestas.');
  end=word.end;return {text:word.text.trim(),start:word.start,end:word.end};
 });
}
const messages={
 UNCERTAIN:'El envío de transcripción tiene un resultado incierto. Se conserva el estado; revisá Modal antes de repetir.',
 RUNNING:'WhisperX sigue procesando. Se conserva call_id para retomar sin reenviar.',
 BUSY:'La transcripción ya está siendo gestionada por otro proceso.',
 CHANGED:'La fuente o los parámetros cambiaron con una transcripción pendiente. Revisá el pedido existente antes de enviar otro.',
 INVALID_RESULT:'Modal devolvió una transcripción inválida. Se conserva call_id; no se reenviará automáticamente.',
 CORRUPT_STATE:'El estado o la caché de transcripción no pasó la validación de integridad.',
 NOT_READY:'No se pudo confirmar la función y el filesystem de WhisperX en Modal. Revisá la conexión y el despliegue existente.',
 REMOTE_FAILED:'La transcripción remota no pudo recuperar su resultado. Se conserva call_id para revisión sin reenviar.',
 INVALID_REQUEST:'La solicitud de transcripción no es válida o la fuente cambió antes de enviarla.',
 ALIGNMENT_UNCERTAIN:'El envío de recuperación de tiempos tiene un resultado incierto. Se conservó su estado para revisarlo sin duplicarlo.',
 ALIGNMENT_FAILED:'No se pudieron recuperar los tiempos de las palabras con el audio. Se conservaron la transcripción y sus identificadores para revisión.',
};
export class ModalTranscriber{
 constructor(config={}, {runImpl=run}={}){this.config=config;this.run=runImpl;}
 settings(){return {app:this.config.modalTranscriptionApp||'kavion-whisperx-real',function:this.config.modalTranscriptionFunction||'transcribe_file',filesystem:this.config.modalTranscriptionFilesystem||'kavion-whisperx-inputs',model:this.config.modalTranscriptionModel||'large-v3',language:'es',diarization:false,environment:this.config.modalTranscriptionEnvironment||'',...(this.config.modalTranscriptionGpu?{gpu:this.config.modalTranscriptionGpu}:{})};}
 environment(){
  const env={};for(const key of ['PATH','HOME','LANG','LC_ALL','SSL_CERT_FILE','SSL_CERT_DIR','REQUESTS_CA_BUNDLE'])if(process.env[key])env[key]=process.env[key];
  env.PYTHONPATH=this.config.pythonLibs||join(this.config.rootDir||ROOT,'runtime/python-libs');env.PYTHONUNBUFFERED='1';env.PYTHONDONTWRITEBYTECODE='1';
  if(this.config.modalConfigPath)env.MODAL_CONFIG_PATH=this.config.modalConfigPath;
  return env;
 }
 command(){return this.config.pythonPath||'python3';}
 script(){return join(this.config.rootDir||ROOT,'scripts/transcribe-modal.py');}
 async check(){
  try{
   const response=await this.run(this.command(),[this.script(),'check',JSON.stringify(this.settings())],{timeout:20000,env:this.environment()});
   const result=JSON.parse(response.stdout.trim().split('\n').at(-1));
   return result.ok===true?{state:'ready',detail:`WhisperX / Modal disponible: ${this.settings().model}, español, sin diarización.`}:{state:'missing',detail:messages.NOT_READY};
  }catch{return {state:'error',detail:messages.NOT_READY};}
 }
 async cached(stateDir,fingerprint){
  let state;try{state=JSON.parse(await privateRead(join(stateDir,'state.json')));}catch(error){if(error.code==='ENOENT')return null;throw attention(messages.CORRUPT_STATE);}
  if(!state||typeof state!=='object'||Array.isArray(state)||state.fingerprint!==fingerprint||!['pending','submitted','complete'].includes(state.phase))throw attention(messages.CORRUPT_STATE);
  if(state.phase!=='pending'&&!/^fc-[A-Za-z0-9_-]{1,200}$/.test(state.call_id||''))throw attention(messages.CORRUPT_STATE);
  if(state.phase!=='complete')return null;
  let bytes;try{bytes=await privateRead(join(stateDir,'result.json'));}catch(error){if(error.code==='ENOENT'&&state.call_id)return null;throw attention(messages.CORRUPT_STATE);}
  if(!/^[a-f0-9]{64}$/.test(state.resultHash||'')||digest(bytes)!==state.resultHash)throw attention(messages.CORRUPT_STATE);
  let result;try{result=JSON.parse(bytes);}catch{throw attention(messages.CORRUPT_STATE);}
  if(result.fingerprint!==fingerprint)throw attention(messages.CORRUPT_STATE);
  return normalize(result.words,this.config.maxVideoDuration||600);
 }
 async transcribe(source,dir){
  const outputDir=await privateDir(resolve(dir)),stateRoot=await privateDir(join(outputDir,'.modal-transcription'));
  const sourcePath=resolve(source),info=await lstat(sourcePath);
  if(!info.isFile()||info.isSymbolicLink()||info.size<=0||info.size>(this.config.maxInputBytes||2*1024**3))throw attention(messages.INVALID_REQUEST);
  const hash=createHash('sha256');for await(const chunk of createReadStream(sourcePath))hash.update(chunk);
  const sourceHash=hash.digest('hex'),settings=this.settings();
  const fingerprint=digest(canonical({version:VERSION,sourceHash,settings}));
  const stateDir=await privateDir(join(stateRoot,fingerprint));
  const cached=await this.cached(stateDir,fingerprint);if(cached)return cached;
  const timeoutMs=this.config.modalTranscriptionTimeoutMs||this.config.providerTimeoutMs||1200000;
  const request={version:VERSION,fingerprint,sourceHash,sourceSize:info.size,source:sourcePath,settings,stateRoot,stateDir,maxDuration:this.config.maxVideoDuration||600,timeoutSeconds:Math.max(1,Math.min(1800,Math.floor(timeoutMs/1000)-10)),...(this.config.modalAlignmentRecovery?{recovery:this.config.modalAlignmentRecovery}:{})};
  const requestPath=join(stateDir,'request.json');await atomicJson(requestPath,request);
  let response;
  try{response=await this.run(this.command(),[this.script(),'transcribe',requestPath],{timeout:timeoutMs,env:this.environment()});}
  catch{throw attention('No se pudo completar la consulta a WhisperX / Modal. Se conserva el estado y cualquier call_id; no se repite el envío incierto.');}
  let envelope;try{envelope=JSON.parse(response.stdout.trim().split('\n').at(-1));}catch{throw attention('Modal no confirmó un resultado válido. Se conserva el estado para revisión.');}
  if(envelope.ok!==true)throw Object.assign(new Error(messages[envelope.code]||messages.REMOTE_FAILED),{code:envelope.code==='RUNNING'?'MODAL_TRANSCRIPTION_RUNNING':envelope.code==='BUSY'?'MODAL_TRANSCRIPTION_BUSY':'MODAL_TRANSCRIPTION_FAILED',needsAttention:!['RUNNING','BUSY'].includes(envelope.code)});
  const words=await this.cached(stateDir,fingerprint);if(!words)throw attention('Modal no dejó un resultado confirmado en la caché privada.');
  await atomicJson(join(outputDir,'transcript.json'),words);return words;
 }
}
