// Runs inside the dedicated Modal media image. All paths come from its private
// job namespace, never from transcript text or a shell command.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {cutVideo,verifyVideo,runMediaCommand} from '../src/media.mjs';
import {renderVideo} from '../src/composition.mjs';

const [requestPath,outputDirArg]=process.argv.slice(2);
const request=JSON.parse(await readFile(requestPath,'utf8'));
const outputDir=resolve(outputDirArg),inputDir=join(resolve(requestPath,'..'),'inputs');
await mkdir(outputDir,{recursive:true});
const config={rootDir:'/opt/kavion-media',dataDir:outputDir,ffmpegPath:'/usr/bin/ffmpeg',ffprobePath:'/usr/bin/ffprobe',hyperframesPath:'/opt/kavion-media/node_modules/hyperframes/bin/hyperframes.mjs',browserExecutablePath:'/usr/bin/chromium',maxSilence:.3,renderTimeoutMs:1_650_000};
if(request.runtimeContract!=='astra-v3')throw new Error('Invalid Astra media runtime contract');
const payload=request.payload;
const localPath=name=>{if(typeof name!=='string'||!/^[a-z0-9-]+\.mp4$/.test(name))throw new Error('Invalid remote media name');return join(inputDir,name);};
let result;
if(request.operation==='cut'){
  result=await cutVideo(localPath('source.mp4'),payload.words,outputDir,{...config,maxSilence:payload.maxSilence??.3},{review:payload.review,originalWords:payload.originalWords});
  result.path=relative(outputDir,result.path);
}else if(request.operation==='repair-broll'){
  const {repairBrollVideo}=await import('../src/media.mjs');
  result=await repairBrollVideo(localPath('source.mp4'),payload.regions,outputDir,config);
  result.path=relative(outputDir,result.path);
}else if(request.operation==='render'){
  if(payload.renderProfile!=='astra-v3'||!payload.plan)throw new Error('Missing validated Astra plan');
  const path=await renderVideo({source:localPath('source.mp4'),words:payload.words,plan:payload.plan,duration:payload.duration,width:payload.width,height:payload.height,brolls:payload.brolls.map(({name,...rest})=>({...rest,path:localPath(name)})),dir:outputDir},config);
  result={path:relative(outputDir,path)};
}else if(request.operation==='verify'){
  const expected={maxSilence:payload.maxSilence??.3};for(const key of ['expectedDuration','expectedWidth','expectedHeight','expectedWordEnd'])if(payload[key]!==undefined)expected[key]=payload[key];
  if(payload.voiceReference===true)expected.voiceReferencePath=localPath('voice-reference.mp4');
  result=await verifyVideo(localPath('source.mp4'),{...config,...expected});
  await writeFile(join(outputDir,'verification.json'),JSON.stringify(result,null,2));
}else if(request.operation==='frames'){
  const {probe}=await import('../src/media.mjs');
  const {extractVisualSheets}=await import('../src/visual-context.mjs');
  const times=payload.times;
  if(!Array.isArray(times)||!times.length||times.length>24||times.some(time=>!Number.isFinite(time)||time<0))throw new Error('Invalid frame times');
  const source=localPath('source.mp4'),metadata=await probe(source,config);
  if(!Number.isFinite(metadata.duration)||times.some(time=>time>=metadata.duration))throw new Error('Frame time exceeds source duration');
  const images=await extractVisualSheets(source,times,outputDir,{...config,visualFramesRemote:false});
  result={images:images.map(image=>relative(outputDir,image))};
}else if(request.operation==='smoke'){
  await mkdir(inputDir,{recursive:true});
  const source=localPath('source.mp4'),broll=localPath('broll-0.mp4');
  await runMediaCommand(config.ffmpegPath,['-y','-v','error','-f','lavfi','-i','testsrc2=size=1080x1920:rate=30:duration=4','-f','lavfi','-i',"aevalsrc='0.25*sin(2*PI*440*t)*(between(t,0.5,1.2)+between(t,2.0,2.7)+between(t,3.0,3.7))':s=48000:d=4",'-c:v','libx264','-pix_fmt','yuv420p','-g','30','-c:a','aac','-b:a','192k','-shortest',source]);
  await runMediaCommand(config.ffmpegPath,['-y','-v','error','-f','lavfi','-i','color=c=0x2d70e7:size=1080x1920:rate=30:duration=1','-c:v','libx264','-pix_fmt','yuv420p',broll]);
  const words=[{text:'Prueba',start:.5,end:1.2},{text:'de',start:2,end:2.7},{text:'video.',start:3,end:3.7}];
  const cut=await cutVideo(source,words,outputDir,config);
  const plan={creativeIntent:'Prueba sintética del contrato editorial de Astra, sin inferencia.',captionGroups:[{startWord:0,endWord:1,emphasis:[0],position:'lower'},{startWord:2,endWord:2,emphasis:[2],position:'lower'}],zooms:[{startWord:2,endWord:2,scale:1.06,position:'upper'}],overlays:[{kind:'headline',text:'Prueba de video',secondaryText:'',valueFrom:0,valueTo:0,suffix:'',position:'upper',startWord:0,endWord:1,evidenceStartWord:0,evidenceEndWord:2}],brolls:[{start:1,duration:1,prompt:'Synthetic blue fixture for deterministic video validation',quote:'de'}]};
  const final=await renderVideo({plan,source:cut.path,words:cut.words,duration:cut.duration,width:1080,height:1920,brolls:[{path:broll,start:1,duration:1}],dir:outputDir},config);
  const verification=await verifyVideo(final,{...config,voiceReferencePath:cut.path,expectedDuration:cut.duration,expectedWidth:1080,expectedHeight:1920,expectedWordEnd:cut.words.at(-1).end});
  if(!verification.ok)throw new Error(`Synthetic verification failed: ${JSON.stringify(verification)}`);
  for(const [name,time]of [['caption',.6],['broll',1.4],['return',2.5]])await runMediaCommand(config.ffmpegPath,['-y','-v','error','-ss',String(time),'-i',final,'-frames:v','1',join(outputDir,`${name}.png`)]);
  result={path:relative(outputDir,final),verification,words:cut.words,segments:cut.segments,sourceIsSynthetic:true,planIsFixture:true,runtimeContract:'astra-v3'};
  await writeFile(join(outputDir,'smoke-report.json'),JSON.stringify(result,null,2));
}else throw new Error('Unknown media operation');
if(result.path&&(isAbsolute(result.path)||result.path.startsWith('..')))throw new Error('Output escaped its namespace');
await writeFile(join(outputDir,'result.json'),JSON.stringify(result));
