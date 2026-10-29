import {randomUUID,createHash} from 'node:crypto';
import {mkdir,lstat,realpath,open,rename,rm,statfs} from 'node:fs/promises';
import path from 'node:path';
import {runMediaCommand} from './media.mjs';

export const VIDEO_EXTENSIONS=new Set(['.mov','.mp4','.m4v','.mkv','.webm','.avi','.mpg','.mpeg','.mts','.m2ts']);
const fail=(message,status=400,code='video_upload')=>Object.assign(new Error(message),{status,code});

export function createUploadReservations({freeBytes=async dir=>{const disk=await statfs(dir,{bigint:true});return disk.bavail*disk.bsize;}}={}){
 let reserved=0n;
 return async(dir,size)=>{
  const free=await freeBytes(dir),bytes=BigInt(size);
  // Compare/update synchronously after the filesystem read so concurrent
  // requests cannot both spend the same free capacity. Keep 1 GiB for the app.
  if(free<bytes+reserved+1024n**3n)throw fail('No hay espacio suficiente para recibir el video. Liberá espacio en el servidor o esperá a que terminen las otras cargas.',507);
  reserved+=bytes;let released=false;
  return()=>{if(!released){reserved-=bytes;released=true;}};
 };
}

async function inspectUpload(file,config){
 const {stdout}=await runMediaCommand(config.ffprobePath||'ffprobe',['-v','error','-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm,avi,mpeg,mpegts','-show_format','-show_streams','-of','json',file],{timeout:60000});
 const data=JSON.parse(stdout),video=data.streams?.find(s=>s.codec_type==='video'),duration=Number(data.format?.duration??video?.duration);
 if(!video||!Number.isFinite(duration)||duration<=0)throw new Error('Invalid video');
 if(duration>(config.maxVideoDuration||600))throw fail('El video supera el límite de 10 minutos.',422);
 // A faststart container can retain valid metadata after media packets have
 // been truncated. Decode before this source can trigger paid processing.
 await runMediaCommand(config.ffmpegPath||'ffmpeg',['-v','error','-xerror','-nostdin','-threads','1','-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm,avi,mpeg,mpegts','-i',file,'-map','0:v:0','-map','0:a:0?','-threads','1','-filter_threads','1','-f','null','-'],{timeout:10*60*1000});
 return {duration,width:video.width,height:video.height,hasAudio:data.streams.some(s=>s.codec_type==='audio')};
}

export function registerUploads(app,{store,config,publicJob}){
 const active=new Set(),reserve=createUploadReservations();
 app.post('/api/jobs/upload',async(req,res,next)=>{
  let dir,handle,keep=false,key,locked=false,response,failure,releaseSpace;
  try{
   if(req.headers['content-type']?.split(';')[0]!=='application/octet-stream')throw fail('Enviá un archivo de video.',415);
   key=req.headers['idempotency-key'];
   if(typeof key!=='string'||!/^[A-Za-z0-9._:-]{1,200}$/.test(key))throw fail('Falta la identificación del envío.');
   let name;try{name=decodeURIComponent(req.headers['x-video-filename']||'');}catch{throw fail('El nombre del archivo no es válido.');}
   if(!name.trim()||name.length>240||/[\\/\u0000-\u001f\u007f]/.test(name)||!VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()))throw fail('Elegí un video MOV, MP4, M4V, MKV, WebM, AVI, MPG, MPEG, MTS o M2TS.');
   const length=req.headers['content-length'];
   if(typeof length!=='string'||!/^\d+$/.test(length)||!Number.isSafeInteger(Number(length))||Number(length)<=0)throw fail('El archivo está vacío o no se pudo determinar su tamaño.');
   const size=Number(length),maxBytes=config.maxInputBytes||2*1024**3;
   if(size>maxBytes)throw fail('El archivo supera el límite de 2 GB.',413);
   const existing=store.getJobByKey(key);
   if(existing&&(existing.sourceType!=='upload'||existing.sourceName!==name||existing.artifacts.source.size!==size))throw fail('Este intento corresponde a otro archivo. Seleccioná el video nuevamente.',409,'idempotency_conflict');
   if(active.has(key))throw fail('Este archivo ya se está subiendo. Esperá a que termine.',409);
   if(active.size>=2)throw fail('Hay otras cargas en curso. Volvé a intentarlo en unos momentos.',429);
   active.add(key);locked=true;
   const root=await realpath(config.dataDir),jobs=path.join(root,'jobs');
   await mkdir(jobs,{recursive:true,mode:0o700});
   const info=await lstat(jobs);
   if(info.isSymbolicLink()||!info.isDirectory()||await realpath(jobs)!==jobs)throw fail('El almacenamiento de videos requiere revisión.',409);
   releaseSpace=await reserve(jobs,size);
   const id=randomUUID();dir=path.join(jobs,id);await mkdir(dir,{mode:0o700});
   const pending=path.join(dir,'source.pending'),file=path.join(dir,'source.mp4');
   handle=await open(pending,'wx',0o600);
   const hash=createHash('sha256');let received=0;
   req.setTimeout(30*60*1000);
   for await(const chunk of req){
    received+=chunk.length;if(received>size||received>maxBytes)throw fail('El archivo supera el tamaño permitido.',413);
    hash.update(chunk);await handle.writeFile(chunk);
   }
   if(received!==size||!req.complete)throw fail('La carga se interrumpió. Volvé a intentar con el mismo archivo.');
   await handle.sync();await handle.close();handle=null;
   const sha256=hash.digest('hex');
   if(existing){
    if(existing.artifacts.source.sha256!==sha256)throw fail('El contenido no coincide con el envío anterior. Seleccioná el archivo nuevamente.',409,'idempotency_conflict');
    response={status:200,job:existing};
   }else{
   let media;try{media=await inspectUpload(pending,config);}catch(error){if(error.status===422)throw error;throw fail('No pudimos leer este video. Verificá que el archivo esté completo y su formato sea compatible.',422);}
   if(!media.hasAudio)throw fail('El video necesita una pista de audio con voz para editarlo.',422);
   if(media.duration>(config.maxVideoDuration||600))throw fail('El video supera el límite de 10 minutos.',422);
   if(!(media.width>0&&media.height>0))throw fail('El video no tiene dimensiones válidas.',422);
   await rename(pending,file);const directory=await open(dir,'r');try{await directory.sync();}finally{await directory.close();}
   const job=store.createUploadedJob({id,idempotencyKey:key,source:{type:'upload',path:file,name,size,sha256,mimeType:'application/octet-stream'}});
   keep=job.id===id;
   response={status:keep?201:200,job};
   }
  }catch(error){
   if(error.code==='ENOSPC')error=fail('Se agotó el espacio del servidor durante la carga.',507);
   failure=error;
  }finally{
   await handle?.close().catch(()=>{});
   if(dir&&!keep)try{await rm(dir,{recursive:true,force:true});}catch(error){failure??=error;}
   releaseSpace?.();
   if(locked)active.delete(key);
  }
  if(req.aborted||res.destroyed)return;
  if(failure)return next(failure);
  res.status(response.status).json(publicJob(response.job));
 });
}
