import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {writeFile,rename,stat,readFile} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ensureMediaDir,probe,planCuts,runMediaCommand} from './media.mjs';
import {buildComposition} from './composition.mjs';

export const MEDIA_RUNTIME_CONTRACT='astra-v3';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function mediaRuntimeFingerprint(root=ROOT){
  const manifest=JSON.parse(await readFile(join(root,'scripts/media-runtime.json'),'utf8'));
  if(manifest.contract!==MEDIA_RUNTIME_CONTRACT)throw new Error('Contrato de medios no válido.');
  const digest=createHash('sha256');
  for(const name of manifest.files){digest.update(name);digest.update(await readFile(join(root,name)));}
  return digest.digest('hex');
}
const expectedKeys=['expectedDuration','expectedWidth','expectedHeight','expectedWordEnd'];
const MAX_SOURCE_BYTES=2*1024**3,MAX_INTERMEDIATE_BYTES=10*1024**3;
async function inputFile(name,path,maxBytes=MAX_SOURCE_BYTES){
  const absolute=resolve(path),info=await stat(absolute);
  if(!info.isFile()||info.size<=0||info.size>maxBytes)throw new Error(`El archivo de medios no es válido o supera ${maxBytes/1024**3} GiB.`);
  const hash=createHash('sha256');for await(const chunk of createReadStream(absolute))hash.update(chunk);
  return {name,path:absolute,size:info.size,sha256:hash.digest('hex')};
}
function resultPath(dir,value){
  if(typeof value!=='string'||isAbsolute(value))throw new Error('Ruta remota de resultado no válida.');
  const target=resolve(dir,value),rel=relative(dir,target);
  if(!rel||rel==='..'||rel.startsWith('../')||isAbsolute(rel))throw new Error('La ruta remota sale del trabajo.');
  return target;
}

export class RemoteMedia {
  constructor(config={}, {runImpl=runMediaCommand}={}){this.config=config;this.run=runImpl;}
  probe(path,config={}){return probe(path,{...this.config,...config});}
  async check(){
    const config=this.config;
    const result=await this.run(config.pythonPath||'python3',[join(config.rootDir||ROOT,'scripts/media_modal.py'),'check',config.remoteMediaApp||'kavion-video-studio-media',config.remoteMediaVolume||'kavion-video-studio-media',config.remoteMediaEnvironment||''],{timeout:20_000,env:this.environment(config)});
    const status=JSON.parse(result.stdout.trim().split('\n').at(-1));
    if(status.ok&&status.runtimeContract!==MEDIA_RUNTIME_CONTRACT)throw new Error('El contrato del runtime Modal no corresponde a Astra v3.');
    if(status.ok&&status.runtimeFingerprint!==await mediaRuntimeFingerprint(config.rootDir||ROOT))throw new Error('La huella del runtime Modal no corresponde al compilador actual.');
    if(!status.ok)throw new Error(status.error||'No se pudo comprobar el render remoto.');
    return {state:'ready',detail:'HyperFrames en Modal con contrato Astra v3 verificado.'};
  }
  environment(config){
    return {KAVION_MEDIA_CLIENT_MODE:'1',PYTHONPATH:config.pythonLibs||join(config.rootDir||ROOT,'runtime/python-libs'),...(config.modalConfigPath?{MODAL_CONFIG_PATH:config.modalConfigPath}:{}),PYTHONUNBUFFERED:'1'};
  }
  async operation(operation,payload,inputs,dir,override={}){
    const config={...this.config,...override},outputDir=await ensureMediaDir(dir,config);
    const stateDir=await ensureMediaDir(join(outputDir,'.remote-media',operation),config);
    const jobKey=createHash('sha256').update(outputDir).digest('hex');
    const runtimeFingerprint=await mediaRuntimeFingerprint(config.rootDir||ROOT);
    const requestHash=createHash('sha256').update(JSON.stringify({runtimeContract:MEDIA_RUNTIME_CONTRACT,runtimeFingerprint,operation,jobKey,payload,inputs:inputs.map(({name,size,sha256})=>({name,size,sha256}))})).digest('hex');
    const request={schema:1,runtimeContract:MEDIA_RUNTIME_CONTRACT,runtimeFingerprint,operation,jobKey,requestHash,payload,inputs,app:config.remoteMediaApp||'kavion-video-studio-media',volume:config.remoteMediaVolume||'kavion-video-studio-media',environment:config.remoteMediaEnvironment||'',timeoutSeconds:Math.min(1800,Math.max(60,Math.floor((config.renderTimeoutMs||1_800_000)/1000)))};
    let previous;
    try{previous=JSON.parse(await readFile(join(stateDir,'state.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(previous?.requestHash&&previous.requestHash!==requestHash)throw Object.assign(new Error('Cambió la solicitud o el runtime después del envío. Se conservan el recibo y el identificador anteriores; requiere revisión.'),{needsAttention:true});
    const requestPath=join(stateDir,'request.json');
    await writeFile(requestPath+'.tmp',JSON.stringify(request),{mode:0o600});await rename(requestPath+'.tmp',requestPath);
    const response=await this.run(config.pythonPath||'python3',[join(config.rootDir||ROOT,'scripts/media_modal.py'),'client',requestPath,join(stateDir,'state.json'),outputDir],{timeout:config.remoteMediaTimeoutMs||((config.renderTimeoutMs||1_800_000)+120_000),env:this.environment(config)});
    let envelope;try{envelope=JSON.parse(response.stdout.trim().split('\n').at(-1));}catch{throw new Error('Modal no devolvió un resultado de medios válido; se conserva el estado para retomar.');}
    if(envelope.receipt&&(envelope.receipt.runtimeContract!==MEDIA_RUNTIME_CONTRACT||envelope.receipt.runtimeFingerprint!==runtimeFingerprint))throw new Error('El recibo corresponde a otra huella de runtime; requiere revisión.');
    if(!envelope.ok){
      if(['MODAL_MEDIA_RUNNING','MODAL_MEDIA_BUSY'].includes(envelope.code))throw Object.assign(new Error('El procesamiento en Modal continúa. Se retomará automáticamente con el mismo identificador.'),{code:envelope.code,needsAttention:false});
      const diagnostic=String(envelope.error||'Falló el procesamiento remoto.');
      // Keep provider traces in private artifacts, not in the user-facing job.
      try{await writeFile(join(stateDir,'error.log'),diagnostic,{mode:0o600,flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
      const uncertain=/incierto|sin recibo|sin resultado|sigue procesando/i.test(diagnostic);
      const names={cut:'El recorte',render:'El renderizado',verify:'La verificación',frames:'La extracción de cuadros',smoke:'La prueba de edición','repair-broll':'La corrección del B-roll'};
      const message=uncertain?'El pedido de edición tiene un resultado incierto. Se conservó su identificador para revisarlo sin duplicarlo.':`${names[operation]||'La edición'} necesita revisión. Se conservaron el video y el avance del trabajo.`;
      throw Object.assign(new Error(message),{needsAttention:envelope.needsAttention===true});
    }
    return envelope.result;
  }
  async cutVideo(source,words,dir,config={}, {review,originalWords}={}){
    planCuts(words,Math.max(...words.map(word=>word.end)));
    const result=await this.operation('cut',{words,...(review?{review}:{}),...(originalWords?{originalWords}:{}),maxSilence:config.maxSilence??this.config.maxSilence??.3},[await inputFile('source.mp4',source)],dir,config);
    return {...result,path:resultPath(resolve(dir),result.path)};
  }
  async repairBrollVideo(source,regions,dir,config={}){
    const {validateBrollRegions}=await import('./media.mjs');
    const checked=validateBrollRegions(regions);
    const result=await this.operation('repair-broll',{regions:checked},[await inputFile('source.mp4',source,MAX_INTERMEDIATE_BYTES)],dir,config);
    return {...result,path:resultPath(resolve(dir),result.path)};
  }
  async renderVideo({source,words,duration,width,height,brolls=[],plan,dir},config={}){
    if(!plan)throw new Error('El render remoto requiere un plan Astra validado.');
    buildComposition({words,duration,width,height,brolls,plan});
    const inputs=[await inputFile('source.mp4',source,MAX_INTERMEDIATE_BYTES)];
    for(const [i,broll]of brolls.entries())inputs.push(await inputFile(`broll-${i}.mp4`,broll.path,MAX_INTERMEDIATE_BYTES));
    const result=await this.operation('render',{renderProfile:'astra-v3',plan,words,duration,width,height,brolls:brolls.map(({start,duration},i)=>({name:`broll-${i}.mp4`,start,duration}))},inputs,dir,config);
    return resultPath(resolve(dir),result.path);
  }
  async verifyVideo(path,config={}){
    const merged={...this.config,...config};
    const payload={maxSilence:merged.maxSilence??.3};for(const key of expectedKeys)if(merged[key]!==undefined)payload[key]=merged[key];
    const inputs=[await inputFile('source.mp4',path,MAX_INTERMEDIATE_BYTES)];
    if(merged.voiceReferencePath){
      inputs.push(await inputFile('voice-reference.mp4',merged.voiceReferencePath,MAX_INTERMEDIATE_BYTES));
      payload.voiceReference=true;
    }
    return this.operation('verify',payload,inputs,dirname(resolve(path)),config);
  }
  async frames(source,times,dir,config={}){
    if(!Array.isArray(times)||!times.length||times.length>24||times.some(time=>!Number.isFinite(time)||time<0))throw new Error('Los tiempos de cuadros no son válidos.');
    const result=await this.operation('frames',{times},[await inputFile('source.mp4',source,MAX_INTERMEDIATE_BYTES)],dir,config);
    if(!Array.isArray(result.images)||result.images.length!==Math.ceil(times.length/6))throw new Error('La extracción remota no devolvió los cuadros esperados.');
    return {images:result.images.map(image=>resultPath(resolve(dir),image))};
  }
  async smoke(dir){
    const result=await this.operation('smoke',{},[],dir);
    return {...result,path:resultPath(resolve(dir),result.path)};
  }
}
