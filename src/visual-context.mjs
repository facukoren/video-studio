import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,readFile,writeFile,chmod,stat,rename,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {ensureMediaDir,probe,runMediaCommand} from './media.mjs';

const VERSION='clavicular-visual-v1';
const attention=message=>Object.assign(new Error(message),{needsAttention:true});
export async function mediaDigest(file){const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');}
const digest=mediaDigest;
async function privateDir(dir,config){await ensureMediaDir(dir,config);if((await lstat(dir)).isSymbolicLink())throw attention('El directorio de revisión visual no puede ser un enlace.');await chmod(dir,0o700);return dir;}
async function json(file,value){const tmp=`${file}.pending`;await writeFile(tmp,JSON.stringify(value,null,2),{mode:0o600});await rename(tmp,file);}
const sampleTimes=duration=>[.01,.15,.29,.53,.69,.9].map(p=>Math.round(Math.min(duration-.01,Math.max(0,duration*p))*1000)/1000);

export async function extractVisualSheets(file,times,dir,config){
 await privateDir(dir,config);
 const info=await probe(file,config),transfer=info.streams.find(s=>s.codec_type==='video')?.color_transfer;
 const grade=['arib-std-b67','smpte2084'].includes(transfer)?'zscale=t=linear:npl=100,format=gbrpf32le,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,':'';
 const images=[];
 for(let page=0;page<Math.ceil(times.length/6);page++){
  const pageDir=await privateDir(join(dir,`page-${page}`),config),chunk=times.slice(page*6,page*6+6);
  for(let i=0;i<chunk.length;i++){
   const target=join(pageDir,`frame-${String(i).padStart(2,'0')}.jpg`);
   // Constant numeric captions only: no user-provided text enters filter syntax.
   const vf=`${grade}scale=360:640:force_original_aspect_ratio=decrease,pad=360:672:(ow-iw)/2:0:color=0x15191f,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='${chunk[i].toFixed(3)} s':x=12:y=645:fontsize=20:fontcolor=white`;
   await runMediaCommand(config.ffmpegPath||'ffmpeg',['-y','-v','error','-threads','1','-ss',String(chunk[i]),'-i',resolve(file),'-frames:v','1','-vf',vf,'-filter_threads','1','-q:v','3',target],{timeout:120000});
   await chmod(target,0o600);
  }
  const image=join(dir,`sheet-${page}.jpg`);
  await runMediaCommand(config.ffmpegPath||'ffmpeg',['-y','-v','error','-threads','1','-framerate','1','-i',join(pageDir,'frame-%02d.jpg'),'-vf',`tile=3x${Math.ceil(chunk.length/3)}:nb_frames=${chunk.length}:color=0x15191f`,'-filter_threads','1','-frames:v','1','-q:v','3',image],{timeout:120000});
  await chmod(image,0o600);images.push(image);
 }
 return images;
}
async function cachedSheets(source,times,dir,config,sha256){
 const key=createHash('sha256').update(JSON.stringify({version:VERSION,sha256,times})).digest('hex');
 const output=await privateDir(join(dir,key),config),manifest=join(output,'manifest.json');
 try{const value=JSON.parse(await readFile(manifest,'utf8'));if(value.key===key&&Array.isArray(value.images)&&value.images.length){
   for(const [i,image] of value.images.entries()){
    if(resolve(image)!==join(output,`sheet-${i}.jpg`))throw Error('invalid cache');
    const info=await lstat(image);if(info.isSymbolicLink())throw attention('La imagen de revisión no puede ser un enlace simbólico.');
    if(!info.isFile()||info.size<1000||info.size!==value.integrity?.[i]?.size||await digest(image)!==value.integrity?.[i]?.sha256)throw Error('invalid cache');
   }
   return value.images;
 }}catch(error){if(error.needsAttention)throw error;}
 const images=config.mediaBackend==='modal'&&config.visualFramesRemote!==false
  ?(await new (await import('./remote-media.mjs')).RemoteMedia(config).frames(source,times,output)).images
  :await extractVisualSheets(source,times,output,config);
 const integrity=[];for(const image of images)integrity.push({size:(await stat(image)).size,sha256:await digest(image)});
 await json(manifest,{key,images,integrity});return images;
}

export async function prepareVisualContext(source,dir,config={}){
 const referencePath=config.referenceVideoPath||join(config.dataDir||dir,'style-reference','reference.mp4');
 try{if(!(await stat(referencePath)).isFile())throw Error();}catch{throw attention('Falta el video de referencia visual de Kavion; preparalo antes de editar.');}
 const output=await privateDir(join(dir,'visual-context'),config);
 const referenceInfo=await probe(referencePath,config),sourceInfo=await probe(source,config);
 const referenceHash=await digest(referencePath),sourceHash=await digest(source);
 const referenceTimes=referenceInfo.duration>44?[1.8,10.5,14.3,26.5,32.7,42.5]:sampleTimes(referenceInfo.duration);
 const sourceTimes=sampleTimes(sourceInfo.duration);
 const refDir=await privateDir(join(config.dataDir||dir,'style-reference','sheets'),config);
 const referenceImages=await cachedSheets(referencePath,referenceTimes,refDir,config,referenceHash);
 const sourceImages=await cachedSheets(source,sourceTimes,output,config,sourceHash);
 const value={version:VERSION,images:[...referenceImages,...sourceImages],reference:{sha256:referenceHash,duration:referenceInfo.duration,width:referenceInfo.width,height:referenceInfo.height,samples:referenceTimes,imageCount:referenceImages.length,style:'kavion-clavicular-v1'},source:{sha256:sourceHash,duration:sourceInfo.duration,width:sourceInfo.width,height:sourceInfo.height,samples:sourceTimes}};
 await json(join(output,'context.json'),value);return value;
}

export function selectReviewTimes(duration,plan={},words=[]){
 const centers=[Math.min(.45,duration/4),Math.max(0,duration-.2)];
 const boundaries=[],allCenters=[],kinds=new Set();
 for(const clip of plan.brolls||[])centers.push(clip.start+clip.duration/2);
 for(const item of [...(plan.scenes||[]),...(plan.overlays||[])]){
  if(!words[item.startWord]||!words[item.endWord])continue;
  const start=words[item.startWord].start,end=words[item.endWord].end;
  const center=(start+end)/2;
  if(!kinds.has(item.kind)){centers.push(center);kinds.add(item.kind);}else allCenters.push(center);
  boundaries.push(start+.2,Math.max(start,end-.08));
 }
 for(const clip of plan.brolls||[]){centers.push(clip.start+clip.duration/2);boundaries.push(clip.start+.2,clip.start+clip.duration-.08);}
 const all=[...centers,...allCenters,...boundaries,...sampleTimes(duration)];
 return [...new Set(all.filter(t=>Number.isFinite(t)&&t>=0&&t<duration).map(t=>Math.round(t*1000)/1000))].slice(0,24).sort((a,b)=>a-b);
}
export async function prepareReviewFrames(output,dir,config={},plan={},words=[]){
 const info=await probe(output,config),sha256=await digest(output),samples=selectReviewTimes(info.duration,plan,words);
 const target=await privateDir(join(dir,'visual-review'),config),images=await cachedSheets(output,samples,target,config,sha256);
 return {images,samples,sha256,width:info.width,height:info.height,duration:info.duration};
}
