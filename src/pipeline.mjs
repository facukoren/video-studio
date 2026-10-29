import path from 'node:path';
import {mkdir,stat,writeFile} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {parseDriveFileUrl} from './providers/drive.mjs';
import {createHash} from 'node:crypto';
import {prepareVisualContext,prepareReviewFrames,mediaDigest} from './visual-context.mjs';
import {validateBrollPlan} from './edit-plan.mjs';
import {validateBrollRepairs} from './providers/editorial.mjs';

export const WORKFLOW_VERSION='astra-modal-v3';
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const planFingerprint=plan=>createHash('sha256').update(JSON.stringify(canonical(plan))).digest('hex');
const needsAttention=message=>Object.assign(new Error(message),{needsAttention:true});
const MAX_QUALITY_REVISIONS=2;
const silenceOnly=verification=>verification?.issues?.length>0&&verification.issues.every(issue=>/^Silencio medido de .*supera el máximo de /i.test(issue));
function mapTimeline(time,segments,toSource){
 if(!Array.isArray(segments)||!segments.length)throw needsAttention('Faltan los segmentos originales para ajustar el montaje automáticamente.');
 let nearest, distance=Infinity;
 for(const segment of segments){
  const start=toSource?segment.outputStart:segment.start,end=start+segment.end-segment.start;
  const point=Math.max(start,Math.min(end,time)),gap=Math.abs(time-point);
  if(gap<distance){distance=gap;nearest=toSource?segment.start+point-start:segment.outputStart+point-start;}
 }
 return nearest;
}
function lockedClips(plan,oldCut,newCut,maxBrolls){
 if(plan.brolls.reduce((total,clip)=>total+clip.duration,0)>newCut.duration+1e-8)throw needsAttention('Los B-rolls pagados no caben en la duración corregida.');
 const scheduled=plan.brolls.map(clip=>{
  const start=oldCut===newCut?clip.start:mapTimeline(mapTimeline(clip.start,oldCut.segments,true),newCut.segments,false);
  return {...clip,start:Math.max(0,Math.min(newCut.duration-clip.duration,start))};
 });
 // Source-time mapping can collapse the gap between two purchased clips.
 // Keep their order and duration, first pushing collisions forward, then
 // fitting the group backwards from the closing boundary if necessary.
 for(let i=1;i<scheduled.length;i++)scheduled[i].start=Math.max(scheduled[i].start,scheduled[i-1].start+scheduled[i-1].duration);
 let boundary=newCut.duration;
 for(let i=scheduled.length-1;i>=0;i--){scheduled[i].start=Math.min(scheduled[i].start,boundary-scheduled[i].duration);boundary=scheduled[i].start;}
 try{validateBrollPlan({brolls:scheduled},newCut.words,newCut.duration,maxBrolls);return scheduled;}
 catch(error){
  // Original positions sometimes retain better transcript anchors after a
  // cut. They are usable only when the entire schedule still validates.
  try{validateBrollPlan(plan,newCut.words,newCut.duration,maxBrolls);return plan.brolls.map(clip=>({...clip}));}
  catch{throw error;}
 }
}
function assertCreativePlan(plan){
 if(plan?.provider!=='codex'||plan.model!=='gpt-6-astra'||plan.effort!=='high'||plan.schemaVersion!==3||plan.visualStyle!=='kavion-clavicular-v1')throw needsAttention('El plan no corresponde a Astra High y la referencia visual actual.');
}


export async function downloadGenerated(url,file,{fetchImpl=fetch,maxBytes=500*1024**2}={}){
 const u=new URL(url);const allowed=['cloudfront.net','higgsfield.ai','fal.media','storage.googleapis.com','r2.cloudflarestorage.com'];
 if(u.protocol!=='https:'||u.username||u.password||!allowed.some(h=>u.hostname===h||u.hostname.endsWith('.'+h)))throw new Error('Higgsfield devolvió una URL de video no permitida.');
 const response=await fetchImpl(u,{redirect:'error',signal:AbortSignal.timeout(180000)});
 if(!response.ok||!response.body)throw new Error('No se pudo descargar el B-roll generado.');
 let count=0;await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,enc,cb){count+=chunk.length;cb(count>maxBytes?new Error('B-roll demasiado grande.'):null,chunk);}}),createWriteStream(file,{mode:0o600}));
 return file;
}
export async function processJob(initial,{store,config,drive,editorial,higgs,media,visuals={prepare:prepareVisualContext,reviewFrames:prepareReviewFrames},preflight=async()=>[],assertLease=()=>{},downloadBroll=downloadGenerated}){
 let job=store.getJob(initial.id),a=job.artifacts||{};const settings=store.getSettings();
 const save=patch=>{assertLease();store.updateJob(job.id,{artifacts:patch});a={...a,...patch};};
 const stage=(name,message)=>{assertLease();store.updateJob(job.id,{status:'running',stage:name,error:null});store.addEvent(job.id,{stage:name,message});};
 try{
  if(job.status==='completed')return;
  const paid=Object.values(a.generations||{}).some(state=>state.jobId||state.pending||state.submittedAt);
  if(a.workflowVersion!==WORKFLOW_VERSION&&(paid||a.render))
   throw needsAttention('Este trabajo pertenece al flujo anterior y ya tiene una generación o un render. Revisalo antes de migrarlo a Astra High; no se volverá a generar ni publicar automáticamente.');
  if(a.workflowVersion===WORKFLOW_VERSION&&a.plan&&(a.plan.provider!=='codex'||a.plan.model!=='gpt-6-astra'||a.plan.effort!=='high'||a.planFingerprint!==planFingerprint(a.plan)))
   throw needsAttention('El plan guardado no coincide con el plan de Astra High confirmado. Se requiere revisión antes de usar o generar B-rolls.');
  if(!a.render){
   if(a.workflowVersion!==WORKFLOW_VERSION){
    // Existing completed renders remain historical. Unsubmitted legacy work
    // retains its download, but none of its old model decisions are relabeled.
    save({workflowVersion:WORKFLOW_VERSION,transcript:null,review:null,cut:null,plan:null,planFingerprint:null,brolls:null,generations:{},visualContext:null,visualReview:null});
   }
   if(settings.maxCreditsPerVideo==null){store.updateJob(job.id,{status:'needs_configuration',error:'Configurá el presupuesto por video antes de comenzar.'});return;}
   const issues=await preflight(a);assertLease();if(issues.length){store.updateJob(job.id,{status:'needs_configuration',error:issues.join(' ')});return;}
  }
  const dir=path.join(config.dataDir,'jobs',job.id);await mkdir(dir,{recursive:true,mode:0o700});
  if(!a.render){
   if(!a.source){stage('download','Descargando el original de Drive.');const source=await drive.download(parseDriveFileUrl(job.sourceUrl),path.join(dir,'source.mp4'));save({source});store.updateJob(job.id,{sourceName:source.name});}
   const info=await media.probe(a.source.path,config);if(!info.hasAudio)throw new Error('El video no tiene una pista de voz.');if(info.duration>(config.maxVideoDuration||600))throw new Error('El video supera el límite de 10 minutos de esta versión.');save({sourceInfo:info});
   if(!a.transcript){stage('transcribe','Transcribiendo y alineando las palabras.');save({transcript:await editorial.transcribe(a.source.path,dir)});}
   if(!a.review){stage('plan','Astra High está revisando el guion y las decisiones de corte.');save({review:await editorial.review(a.transcript,info,dir)});}
   if(!a.cut){stage('cut','Aplicando los cortes de Astra High y recortando las pausas.');save({cut:await media.cutVideo(a.source.path,a.review.words,dir,config,{review:a.review,originalWords:a.transcript})});}
   const visualContext=await visuals.prepare(a.cut.path,dir,config);
   if(a.plan&&a.visualContext?.reference?.sha256!==visualContext.reference.sha256)throw needsAttention('La referencia visual cambió después de confirmar el plan. Revisá el trabajo antes de continuar.');
   save({visualContext});
   if(!a.plan){stage('story','Astra High está diseñando las escenas a partir del guion y la referencia visual.');const plan=await editorial.plan(a.cut.words,a.cut.duration,settings.maxBrolls,dir,visualContext);assertCreativePlan(plan);save({plan,planFingerprint:planFingerprint(plan)});await writeFile(path.join(dir,'edit-plan.json'),JSON.stringify(a.plan,null,2),{mode:0o600});}
   if(!a.brolls){
    stage('broll','Preparando B-rolls coherentes con el guion.');
    const ratio=info.width===info.height?'1:1':info.width>info.height?'16:9':'9:16';
    const clips=a.plan.brolls.map(c=>({...c,aspectRatio:ratio}));
    const states=a.generations||{};
    const account=await higgs.check({requireCredits:clips.some((_,i)=>!states[i]?.jobId)});let total=0;const quotes=[];
    for(let i=0;i<clips.length;i++){const c=states[i]?.estimatedCredits??await higgs.cost(clips[i]);quotes.push(c);total+=c;}
    const already=Object.values(states).filter(s=>s.jobId).reduce((n,s)=>n+(s.estimatedCredits||0),0);
    if(total>settings.maxCreditsPerVideo)throw Object.assign(new Error(`Los B-rolls cuestan ${total} créditos y superan el límite de ${settings.maxCreditsPerVideo}. Ajustá el presupuesto en Configuración.`),{needsAttention:true});
    if(total-already>account.credits)throw Object.assign(new Error('Saldo insuficiente para todos los B-rolls de este video.'),{needsAttention:true});
    const brolls=[];
    for(let i=0;i<clips.length;i++){
     const generated=await higgs.generate(clips[i],{budget:quotes[i],state:states[i]||{},checkpoint:s=>{states[i]=s;save({generations:{...states}});}});
     const local=path.join(dir,`broll-${i}.mp4`);let exists=false;try{exists=(await stat(local)).size>0&&states[i]?.downloaded;}catch{}
     if(!exists){await downloadBroll(generated.url,local);states[i]={...states[i],downloaded:true};save({generations:{...states}});}
     const probe=await media.probe(local,config);if(probe.duration+0.04<clips[i].duration)throw new Error('El B-roll generado es más corto que el tramo previsto.');
     brolls.push({path:local,start:clips[i].start,duration:clips[i].duration});
    }
    save({brolls,estimatedCredits:total});
   }
   stage('render','Renderizando el montaje con HyperFrames.');
   const output=await media.renderVideo({source:a.cut.path,words:a.cut.words,duration:a.cut.duration,width:info.width,height:info.height,brolls:a.brolls,plan:a.plan,dir},config);save({render:{path:output}});
  }
  // Persist each revision before external work. Its directory and partial results
  // remain stable across worker restarts and retain the original paid receipts.
  const assertContentRevisionSafe=()=>{
   if(a.upload&&Object.keys(a.upload).length)throw needsAttention('La subida ya tiene una sesión guardada. Se conserva su identidad antes de revisar el contenido.');
  };
  const beginRecovery=(kind,feedback,rejectedFrames)=>{
   assertContentRevisionSafe();
   if(!a.source?.path||!a.review?.words||!a.transcript||!a.cut||!a.plan?.brolls||!a.brolls)return false;
   const recovery=a.recovery||{history:[]};const count=(recovery[`${kind}Attempts`]||0)+1;
   if(count>MAX_QUALITY_REVISIONS)throw new Error(`Se agotaron los ${MAX_QUALITY_REVISIONS} intentos de corrección automática ${kind==='technical'?'de las pausas':'del montaje visual'}.`);
   const revisionDir=path.join(dir,'recovery',`${kind}-${count}`);
   save({recovery:{...recovery,[`${kind}Attempts`]:count,pending:{kind,number:count,dir:revisionDir,feedback,baseCut:a.cut,basePlan:a.plan,baseBrolls:a.brolls,baseVisualContext:a.visualContext,rejectedFrames,startedAt:new Date().toISOString()}}});
   return true;
  };
  const resumeRecovery=async()=>{
   assertContentRevisionSafe();
   let pending=a.recovery.pending;
   const checkpoint=patch=>{pending={...pending,...patch};save({recovery:{...a.recovery,pending}});};
   await mkdir(pending.dir,{recursive:true,mode:0o700});
   if(!pending.cut){
    if(pending.kind==='technical'){
     stage('cut','Corrigiendo automáticamente las pausas con el audio original.');
     checkpoint({cut:await media.cutVideo(a.source.path,a.review.words,pending.dir,config,{review:a.review,originalWords:a.transcript})});
    }else checkpoint({cut:pending.baseCut});
   }
   if(pending.kind==='visual'&&!pending.brollRepairComplete){
    if(pending.plan)throw needsAttention('La revisión visual pendiente ya tiene un plan anterior al tratamiento de B-rolls. Se necesita una nueva identidad de revisión para preservar sus pedidos guardados.');
    if(!pending.brollInspections)checkpoint({brollInspections:{},brollRepairResults:{},brollInspectionRequests:{},brollTreatmentRequests:{}});
    for(const [index,asset]of pending.baseBrolls.entries()){
     if(pending.brollInspections[index])continue;
     const duration=pending.basePlan.brolls[index].duration;
     const sampleCount=pending.baseBrolls.length<=4?12:6;
     const times=Array.from({length:sampleCount},(_,i)=>duration*(i+.5)/sampleCount);
     const request=pending.brollInspectionRequests[index]||{source:asset.path,times,dir:path.join(pending.dir,`broll-inspection-${index}`)};
     if(!pending.brollInspectionRequests[index])checkpoint({brollInspectionRequests:{...pending.brollInspectionRequests,[index]:request}});
     stage('verify','Inspeccionando los B-rolls preparados para corregir artefactos visuales.');
     const frames=await media.frames(request.source,request.times,request.dir,config);
     if(!Array.isArray(frames.images)||!frames.images.length||frames.images.some(image=>typeof image!=='string'||!image))throw new Error('La inspección de B-roll no devolvió cuadros válidos.');
     checkpoint({brollInspections:{...pending.brollInspections,[index]:{index,images:frames.images,times:request.times}}});
    }
    if(!pending.brollRepairInput){
     const images=[],samples=[];
     for(const [index]of pending.baseBrolls.entries()){
      const inspection=pending.brollInspections[index],imageIndices=inspection.images.map((_,i)=>images.length+i);
      images.push(...inspection.images);samples.push({index,imageIndices,times:inspection.times});
     }
     if(images.length>8)throw new Error('La inspección de B-roll supera el límite de ocho imágenes.');
     checkpoint({brollRepairInput:{images,brolls:pending.basePlan.brolls.map((clip,index)=>({index,...clip,repairRegions:pending.baseBrolls[index].repairRegions||[]})),issues:pending.feedback.issues||[],samples}});
    }
    if(!pending.brollRepairProposal){
     const proposal=validateBrollRepairs(await editorial.repairBrollPlan(pending.brollRepairInput,pending.dir),pending.baseBrolls.length,pending.baseBrolls);
     checkpoint({brollRepairProposal:proposal});
    }
    const repairProposal=validateBrollRepairs(pending.brollRepairProposal,pending.baseBrolls.length,pending.baseBrolls);
    const selectedBrollIndices=pending.baseBrolls.map((_,index)=>index).filter(index=>!(repairProposal.omitIndices||[]).includes(index));
    if(!pending.selectedBrollIndices)checkpoint({selectedBrollIndices,omittedBrolls:(repairProposal.omitIndices||[]).map(index=>({...pending.baseBrolls[index],index}))});
    else if(planFingerprint(pending.selectedBrollIndices)!==planFingerprint(selectedBrollIndices))throw needsAttention('La selección de B-roll cambió después de confirmar la revisión guardada.');
    for(const repair of repairProposal.repairs){
     if(pending.brollRepairResults[repair.index])continue;
     const request=pending.brollTreatmentRequests[repair.index]||{source:pending.baseBrolls[repair.index].path,regions:repair.regions,dir:path.join(pending.dir,`broll-repair-${repair.index}`)};
     if(!pending.brollTreatmentRequests[repair.index])checkpoint({brollTreatmentRequests:{...pending.brollTreatmentRequests,[repair.index]:request}});
     stage('broll','Corrigiendo el texto y las interfaces incoherentes de los B-rolls preparados.');
     const result=await media.repairBrollVideo(request.source,request.regions,request.dir,config);
     if(typeof result.path!=='string'||!result.path||planFingerprint(result.regions)!==planFingerprint(request.regions))throw new Error('La reparación de B-roll no confirmó el archivo y las regiones solicitadas.');
     checkpoint({brollRepairResults:{...pending.brollRepairResults,[repair.index]:{index:repair.index,source:request.source,path:result.path,regions:result.regions,repairRegions:[...(pending.baseBrolls[repair.index].repairRegions||[]),...result.regions]}}});
    }
    checkpoint({repairedBrolls:pending.selectedBrollIndices.map(index=>({...pending.baseBrolls[index],...(pending.brollRepairResults[index]?{path:pending.brollRepairResults[index].path,repairRegions:pending.brollRepairResults[index].repairRegions}:{})})),brollRepairComplete:true,visualContext:null});
   }
   if(!pending.visualContext){
    const context=await visuals.prepare(pending.cut.path,pending.dir,config);
    if(context.reference?.sha256!==pending.baseVisualContext?.reference?.sha256)throw needsAttention('La referencia visual cambió durante la corrección automática. Se conserva el montaje anterior.');
    const selectedPlan=pending.selectedBrollIndices?{...pending.basePlan,brolls:pending.selectedBrollIndices.map(index=>pending.basePlan.brolls[index])}:pending.basePlan;
    const lockedBrolls=lockedClips(selectedPlan,pending.baseCut,pending.cut,settings.maxBrolls);
    validateBrollPlan({brolls:lockedBrolls},pending.cut.words,pending.cut.duration,settings.maxBrolls);
    const rejectedImages=(pending.rejectedFrames?.images||[]).slice(0,Math.min(4,8-(context.reference.imageCount||1)));
    const contextImages=context.images.slice(0,8-rejectedImages.length);
    checkpoint({visualContext:{...context,images:[...contextImages,...rejectedImages],lockedBrolls,repairFeedback:{...pending.feedback,previousPlan:pending.basePlan,...(pending.brollRepairComplete?{brollRepairs:Object.values(pending.brollRepairResults),omittedBrolls:pending.omittedBrolls||[]}:{}),...(rejectedImages.length?{rejectedFrames:{imageIndices:rejectedImages.map((_,i)=>contextImages.length+i),samples:pending.rejectedFrames.samples}}:{})}}});
   }
   if(!pending.plan){
    stage('story','Astra High está corrigiendo el montaje con los B-rolls ya preparados.');
    const plan=await editorial.plan(pending.cut.words,pending.cut.duration,settings.maxBrolls,pending.dir,pending.visualContext);
    assertCreativePlan(plan);
    validateBrollPlan(plan,pending.cut.words,pending.cut.duration,settings.maxBrolls);
    if(planFingerprint(plan.brolls)!==planFingerprint(pending.visualContext.lockedBrolls))throw needsAttention('La corrección no conservó los B-rolls pagados fijados.');
    checkpoint({plan});
    await writeFile(path.join(pending.dir,'edit-plan.json'),JSON.stringify(plan,null,2),{mode:0o600});
   }
   const brolls=(pending.repairedBrolls||pending.baseBrolls).map((clip,index)=>({...clip,start:pending.plan.brolls[index].start,duration:pending.plan.brolls[index].duration}));
   if(!pending.render){
    stage('render','Renderizando la corrección automática del montaje.');
    const output=await media.renderVideo({source:pending.cut.path,words:pending.cut.words,duration:pending.cut.duration,width:a.sourceInfo.width,height:a.sourceInfo.height,brolls,plan:pending.plan,dir:pending.dir},config);
    checkpoint({render:{path:output}});
   }
   const entry={kind:pending.kind,number:pending.number,dir:pending.dir,feedback:pending.feedback,previousRender:a.render,previousCut:pending.baseCut,previousPlan:pending.basePlan,previousBrolls:pending.baseBrolls,previousVisualContext:pending.baseVisualContext,brollRepairs:Object.values(pending.brollRepairResults||{}),brollRepairInput:pending.brollRepairInput,brollRepairProposal:pending.brollRepairProposal,selectedBrollIndices:pending.selectedBrollIndices,omittedBrolls:pending.omittedBrolls||[],previousVerification:a.verification,previousVisualReview:a.visualReview,startedAt:pending.startedAt,renderedAt:new Date().toISOString()};
   save({cut:pending.cut,visualContext:pending.visualContext,plan:pending.plan,planFingerprint:planFingerprint(pending.plan),brolls,render:pending.render,verification:null,verificationFingerprint:null,visualReview:null,recovery:{...a.recovery,pending:null,history:[...(a.recovery.history||[]),entry]}});
  };
  for(;;){
  if(a.recovery?.pending)await resumeRecovery();
  const outputDir=path.isAbsolute(a.render.path)?path.dirname(a.render.path):dir;
  const digest=visuals.digest||mediaDigest;
  const verificationFingerprint=planFingerprint({render:await digest(a.render.path),voice:a.cut?.path?await digest(a.cut.path):null,duration:a.cut?.duration,width:a.sourceInfo?.width,height:a.sourceInfo?.height,wordEnd:a.cut?.words?.at(-1)?.end,maxSilence:config.maxSilence??.3});
  if(!a.verification||a.verificationFingerprint!==verificationFingerprint){stage('verify','Verificando audio, duración y pausas de la voz original.');const verification=await media.verifyVideo(a.render.path,{...config,voiceReferencePath:a.cut?.path,expectedDuration:a.cut?.duration,expectedWidth:a.sourceInfo?.width,expectedHeight:a.sourceInfo?.height,expectedWordEnd:a.cut?.words?.at(-1)?.end});save({verification,verificationFingerprint});await writeFile(path.join(outputDir,'verification.json'),JSON.stringify(verification,null,2));}
  if(!a.verification.ok){
   if(silenceOnly(a.verification)&&beginRecovery('technical',{issues:a.verification.issues}))continue;
   throw needsAttention(`La revisión del video requiere atención: ${(a.verification.issues||[]).join(' ')}`);
  }
  stage('verify','Astra High está comparando el montaje con la referencia visual.');
  if(!a.visualContext?.reference||!a.visualContext.images?.length)throw needsAttention('Falta la referencia visual del montaje; se requiere revisión antes de entregar.');
  const frames=await visuals.reviewFrames(a.render.path,outputDir,config,a.plan,a.cut?.words||[]);
  if(!a.visualReview||a.visualReview.renderSha256!==frames.sha256||a.visualReview.planFingerprint!==a.planFingerprint){
   const referenceImages=a.visualContext.images.slice(0,a.visualContext.reference.imageCount||1);
   const review=await editorial.reviewVisual({images:[...referenceImages,...frames.images],reference:a.visualContext.reference,plan:a.plan,words:a.cut?.words||[],duration:a.cut?.duration},outputDir);
   if(review.model!=='gpt-6-astra'||review.effort!=='high')throw needsAttention('La revisión visual debe usar Astra High.');
   save({visualReview:{...review,renderSha256:frames.sha256,planFingerprint:a.planFingerprint,samples:frames.samples}});
   await writeFile(path.join(outputDir,'visual-review.json'),JSON.stringify(a.visualReview,null,2),{mode:0o600});
  }
  if(!a.visualReview.ok){
   if(beginRecovery('visual',{issues:a.visualReview.issues,summary:a.visualReview.summary},frames))continue;
   throw needsAttention(`La revisión visual requiere ajustes: ${(a.visualReview.issues||[]).join(' ')}`);
  }
  break;
  }
  stage('upload','Subiendo el MP4 verificado a Drive.');
  const name=`${path.parse(job.sourceName||a.source?.name||'video').name}-editado-${job.id.slice(0,8)}.mp4`;
  const result=await drive.upload(a.render.path,{jobId:job.id,name,folderId:settings.destinationFolderId,checkpoint:a.upload||{},onCheckpoint:state=>save({upload:state})});
  if(!result.fileId||!result.url)throw new Error('Drive no confirmó el archivo subido.');
  assertLease();store.updateJob(job.id,{status:'completed',stage:'completed',result,error:null});store.addEvent(job.id,{stage:'completed',message:'Video verificado y guardado en Drive.'});
 }catch(error){
  try{assertLease();}catch{return;}
  const text=error.message||'La edición no pudo terminar.';
  const uncertain=/incierto/i.test(text);
  const waiting=['LOCAL_RESOURCES_WAIT','PROCESSOR_OFFLINE','MODAL_TRANSCRIPTION_RUNNING','MODAL_TRANSCRIPTION_BUSY','MODAL_MEDIA_RUNNING','MODAL_MEDIA_BUSY'].includes(error.code);
  store.updateJob(job.id,{status:waiting?'queued':error.needsAttention||uncertain?'needs_attention':'failed',error:text,retryAfter:waiting?Date.now()+60000:null});
  store.addEvent(job.id,{stage:store.getJob(job.id).stage,message:text});
 }
}
