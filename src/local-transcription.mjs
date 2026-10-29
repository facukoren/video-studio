import {createHash,randomUUID} from 'node:crypto';
import {createReadStream,readFileSync} from 'node:fs';
import {readFile,writeFile,rename,stat,mkdir,rm} from 'node:fs/promises';
import {freemem} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runMediaCommand} from './media.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function localAvailableMemoryMb(){
 if(process.platform==='linux')try{return Number(readFileSync('/proc/meminfo','utf8').match(/^MemAvailable:\s+(\d+)/m)[1])/1024;}catch{}
 return freemem()/1024**2;
}
async function atomicJson(file,value){
 const temporary=`${file}.${randomUUID()}.tmp`;
 try{await writeFile(temporary,JSON.stringify(value,null,2),{mode:0o600});await rename(temporary,file);}finally{await rm(temporary,{force:true});}
}
async function json(file){if((await stat(file)).size>16*1024**2)throw new Error('La transcripción supera el tamaño permitido.');return JSON.parse(await readFile(file,'utf8'));}
function normalize(payload){
 if(!Array.isArray(payload.words)||!payload.words.length||payload.words.length>100000||!Number.isFinite(payload.duration)||payload.duration<=0)throw new Error('La transcripción local no devolvió palabras y duración válidas.');
 let previousEnd=0;
 return payload.words.map(w=>{
  const text=String(w.text??w.word??'').trim();
  if(!text||text.length>2000||!Number.isFinite(w.start)||!Number.isFinite(w.end)||w.start<previousEnd-1e-8||w.end<=w.start||w.end>payload.duration+.04)throw new Error('La transcripción contiene tiempos inválidos o palabras superpuestas.');
  previousEnd=w.end;return {text,start:w.start,end:w.end};
 });
}
export class LocalTranscriber{
 constructor(config,{runImpl=runMediaCommand,memoryImpl=localAvailableMemoryMb}={}){this.config=config;this.run=runImpl;this.memory=memoryImpl;}
 settings(){return {model:this.config.localWhisperModel||'medium',modelPath:resolve(this.config.localWhisperModelPath||join(ROOT,'runtime/models/whisper-medium')),device:this.config.localWhisperDevice||'cpu',computeType:this.config.localWhisperComputeType||'int8',threads:this.config.localWhisperThreads??2,language:'es',beamSize:5};}
 command(){return this.config.localPythonPath||this.config.pythonPath||'python3';}
 script(){return join(this.config.rootDir||ROOT,'scripts/transcribe-local.py');}
 environment(){return {HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1',PYTHONDONTWRITEBYTECODE:'1',OMP_NUM_THREADS:String(this.settings().threads)};}
 async inspect(){
  const result=await this.run(this.command(),[this.script(),'check',JSON.stringify(this.settings())],{timeout:15000,env:this.environment()});
  return JSON.parse(result.stdout);
 }
 memoryStatus(){
  const available=Math.floor(this.memory()),required=this.config.localTranscriptionMinMemoryMb??3072;
  return available<required?{state:'waiting',detail:`Esperando memoria para Whisper ${this.settings().model}: ${available} MiB disponibles; se requieren ${required} MiB. No se cambia el modelo ni se envía el audio a otro proveedor.`}:null;
 }
 async check(){
  try{const info=await this.inspect();if(!info.ready)return {state:'missing',detail:info.detail};return this.memoryStatus()||{state:'ready',detail:`Whisper ${this.settings().model} local, ${this.settings().device}/${this.settings().computeType}; modelo instalado.`};}
  catch{return {state:'missing',detail:'No se pudo comprobar Python y Whisper local. Configurá LOCAL_PYTHON_PATH y el modelo local antes de iniciar.'};}
 }
 async transcribe(source,dir){
  await mkdir(dir,{recursive:true,mode:0o700});
  const info=await this.inspect();if(!info.ready)throw Object.assign(new Error(info.detail||'Falta instalar Whisper local.'),{code:'LOCAL_TRANSCRIPTION_MISSING'});
  const settings=this.settings(),hash=createHash('sha256');
  for await(const block of createReadStream(source))hash.update(block);
  const sourceHash=hash.digest('hex');
  const fingerprint=createHash('sha256').update(JSON.stringify({sourceHash,settings,version:info.version,modelFingerprint:info.modelFingerprint})).digest('hex');
  const statePath=join(dir,'local-transcription-state.json');
  let cached;try{cached=await json(statePath);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(cached?.fingerprint===fingerprint)return normalize(cached);
  const waiting=this.memoryStatus();if(waiting)throw Object.assign(new Error(waiting.detail),{code:'LOCAL_RESOURCES_WAIT'});
  const output=join(dir,'transcript-local-raw.json'),requestPath=join(dir,'local-transcription-request.json');
  await atomicJson(requestPath,{...settings,source:resolve(source),output:resolve(output)});
  // A failed run must never leave an older result eligible for this fingerprint.
  await rm(output,{force:true});
  await this.run(this.command(),[this.script(),'transcribe',requestPath],{timeout:this.config.localTranscriptionTimeoutMs??7200000,env:this.environment()});
  const payload=await json(output),words=normalize(payload);
  await atomicJson(statePath,{schema:1,fingerprint,sourceHash,...settings,version:info.version,modelFingerprint:info.modelFingerprint,duration:payload.duration,words});
  await atomicJson(join(dir,'transcript.json'),words);return words;
 }
}
