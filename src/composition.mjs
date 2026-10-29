import { copyFile, writeFile, rename, stat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ensureMediaDir, runMediaCommand, planCuts, probe } from './media.mjs';
import { validateCreativePlan } from './edit-plan.mjs';
import { buildReferenceComposition, REFERENCE_SOUNDS } from './reference-composition.mjs';

const require = createRequire(import.meta.url);
const escapeHtml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
// JSON inside a script must not be able to terminate the HTML script element.
const scriptJson = value => JSON.stringify(value).replaceAll('<','\\u003c').replaceAll('>','\\u003e').replaceAll('&','\\u0026').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');

function historicalCaptionGroups(words) {
  const groups = [];
  let current = [];
  for (const [index, word] of words.entries()) {
    const previous = current.at(-1);
    if (previous && (current.length === 3 || word.start - previous.end >= .15 || /[.!?…]$/.test(previous.text) || current.reduce((n, w) => n + w.text.length, 0) + word.text.length > 26)) { groups.push(current); current = []; }
    current.push({ ...word, index });
  }
  if (current.length) groups.push(current);
  return groups.map(group=>({words:group,position:'lower',emphasis:[]}));
}
const rangeTimes=(item,words)=>({start:words[item.startWord].start,end:words[item.endWord].end});

export function buildComposition({ words, duration, width, height, brolls = [], plan }) {
  planCuts(words, duration); // Shared validation; do not alter the edited timing.
  if (![width, height].every(n => Number.isInteger(n) && n >= 64 && n <= 7680)) throw new Error('Invalid composition dimensions');
  for (const broll of brolls) if (!Number.isFinite(broll.start) || !Number.isFinite(broll.duration) || broll.start < 0 || broll.duration <= 0 || broll.start + broll.duration > duration + 1e-8) throw new Error('B-roll duration is outside the composition');
  let creative;
  if(plan){
    const {creativeIntent,captionGroups,zooms,overlays,brolls:plannedBrolls}=plan;
    const referenceFields=plan.visualStyle?{visualStyle:plan.visualStyle,scenes:plan.scenes,soundCues:plan.soundCues,framing:plan.framing}:{};
    creative=validateCreativePlan({creativeIntent,captionGroups,zooms,overlays,brolls:plannedBrolls,...referenceFields},words,duration,8);
    if(brolls.length!==creative.brolls.length||brolls.some((clip,i)=>Math.abs(clip.start-creative.brolls[i].start)>1e-8||Math.abs(clip.duration-creative.brolls[i].duration)>1e-8))throw new Error('Los assets de B-roll no coinciden con el plan creativo validado.');
  }
  if(creative?.visualStyle==='kavion-clavicular-v1')return buildReferenceComposition({words,duration,width,height,brolls,creative});
  // Compatibility is deliberately limited to historical callers. The worker
  // requires an Astra plan for every new job before reaching this compiler.
  const groups=creative?creative.captionGroups.map(group=>({words:words.slice(group.startWord,group.endWord+1).map((word,i)=>({...word,index:group.startWord+i})),position:group.position,emphasis:group.emphasis})):historicalCaptionGroups(words);
  const fontSize=Math.max(14,Math.round(width*(height>width?.072:.044)));
  const overlaySize=Math.max(18,Math.round(width*(height>width?.078:.052)));
  const wordTimes=words.map(({start,end})=>({start,end}));
  const captionTimes=groups.map(group=>({start:group.words[0].start,end:group.words.at(-1).end}));
  const zooms=creative?creative.zooms.map(zoom=>({...rangeTimes(zoom,words),scale:zoom.scale,origin:zoom.position==='upper'?'50% 38%':'50% 50%'})):words.filter((word,i)=>i>0&&/[.!?…]$/.test(words[i-1].text)&&word.start>1&&word.start<duration-1).map(word=>({start:word.start,end:Math.min(duration,word.start+1),scale:1.055,origin:'50% 42%'}));
  const overlays=(creative?.overlays||[]).map(overlay=>({...overlay,...rangeTimes(overlay,words)}));
  const overlayTimings=overlays.map(({start,end,kind,valueFrom,valueTo,suffix})=>({start,end,kind,valueFrom,valueTo,suffix}));
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=${width}, height=${height}">
<title>Edición Kavion</title><script src="assets/gsap.min.js"></script>
<style>
@font-face{font-family:KavionInter;src:url('assets/InterVariable.woff2') format('woff2');font-weight:100 900;font-display:block}
*{box-sizing:border-box}html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#08090b}
#root{position:relative;width:100%;height:100%;overflow:hidden;font-family:KavionInter,Inter,sans-serif}
#camera{position:absolute;inset:0;transform-origin:50% 42%}.footage{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
#source{z-index:1}.broll{z-index:2;background:#08090b}#captions{position:absolute;inset:0;z-index:4;pointer-events:none}
.caption{position:absolute;left:10%;width:80%;bottom:${height>width?`${Math.round(height*650/1920)}px`:'11%'};text-align:center;font-size:${fontSize}px;font-weight:850;line-height:1.18;letter-spacing:-.025em;color:#fff;overflow:visible}
.caption.center{bottom:43%}.caption-inner{display:inline;box-decoration-break:clone;-webkit-box-decoration-break:clone;background:rgba(0,0,0,.73);border-radius:${Math.round(fontSize*.28)}px;padding:${Math.round(fontSize*.12)}px ${Math.round(fontSize*.2)}px;text-shadow:0 2px 5px #000;overflow-wrap:anywhere}
.word{display:inline;color:#fff}.word.emphasis{font-weight:950;color:#ffe568}.word.active{color:#ffe568;text-shadow:0 0 12px #ffe56855}
#graphics{position:absolute;inset:0;z-index:3;pointer-events:none}.overlay{position:absolute;left:9%;width:82%;top:13%;padding:${Math.round(overlaySize*.35)}px;border-radius:${Math.round(overlaySize*.3)}px;background:rgba(8,9,11,.87);border:1px solid #ffffff28;text-align:center;color:#fff;font-size:${overlaySize}px;font-weight:850;line-height:1.1;letter-spacing:-.035em;overflow-wrap:anywhere}
.overlay.center{top:35%}.overlay-keyword{color:#ffe568;font-size:${Math.round(overlaySize*1.12)}px}.overlay-comparison{display:flex;align-items:center;justify-content:center;gap:${Math.round(overlaySize*.22)}px;font-size:${Math.round(overlaySize*.72)}px}.comparison-side{flex:1;min-width:0}.comparison-side:last-child{color:#ffe568}.comparison-divider{font-size:.46em;color:#a8abb5;letter-spacing:0}.counter-label{display:block;font-size:.48em;letter-spacing:0;color:#c6cad2;margin-bottom:.35em}.counter-value{display:block;color:#ffe568;font-variant-numeric:tabular-nums}
</style></head><body>
<div id="root" data-composition-id="main" data-root="true" data-width="${width}" data-height="${height}" data-start="0" data-duration="${duration}" data-fps="30">
<div id="camera" data-layout-allow-overflow><video id="source" class="clip footage" src="assets/source.mp4" data-start="0" data-duration="${duration}" data-track-index="0" data-has-audio="true" playsinline></video></div>
${brolls.map((broll,i)=>`<video id="broll-${i}" class="clip footage broll" src="assets/broll-${i}.mp4" data-start="${broll.start}" data-duration="${broll.duration}" data-track-index="1" muted playsinline></video>`).join('\n')}
<div id="graphics" data-layout-allow-overlap>
${overlays.map((overlay,i)=>`<div id="overlay-${i}" class="clip overlay overlay-${overlay.kind} ${overlay.position}" data-start="${overlay.start}" data-duration="${overlay.end-overlay.start}" data-track-index="3">${overlay.kind==='comparison'?`<span class="comparison-side">${escapeHtml(overlay.text)}</span><span class="comparison-divider">VS</span><span class="comparison-side">${escapeHtml(overlay.secondaryText)}</span>`:overlay.kind==='counter'?`<span class="counter-label">${escapeHtml(overlay.text)}</span><span id="counter-${i}" class="counter-value">${overlay.valueFrom}${escapeHtml(overlay.suffix)}</span>`:escapeHtml(overlay.text)}</div>`).join('\n')}
</div>
<div id="captions" data-track-kind="captions" data-layout-allow-overlap>
${groups.map((group,i)=>`<div id="caption-${i}" class="clip caption ${group.position}" data-start="${group.words[0].start}" data-duration="${group.words.at(-1).end-group.words[0].start}" data-track-index="2"><span class="caption-inner">${group.words.map(word=>`<span id="word-${word.index}" class="word${group.emphasis.includes(word.index)?' emphasis':''}">${escapeHtml(word.text)}</span>`).join(' ')}</span></div>`).join('\n')}
</div></div>
<script>
(function(){
const timings=${scriptJson(wordTimes)};
const captions=${scriptJson(captionTimes)};
const zooms=${scriptJson(zooms)};
const overlays=${scriptJson(overlayTimings)};
const tl=gsap.timeline({paused:true});
tl.to({}, {duration:${duration}}, 0);
function renderAt(time){
 timings.forEach((word,i)=>document.getElementById('word-'+i).classList.toggle('active',time>=word.start&&time<word.end));
 captions.forEach((caption,i)=>{document.getElementById('caption-'+i).style.visibility=time>=caption.start&&time<caption.end?'visible':'hidden';});
 const camera=document.getElementById('camera');let scale=1,origin='50% 42%';
 for(const zoom of zooms){if(time>=zoom.start&&time<zoom.end){const ramp=Math.min(.12,(zoom.end-zoom.start)/3);const weight=Math.min(1,(time-zoom.start)/ramp,(zoom.end-time)/ramp);scale=1+(zoom.scale-1)*weight;origin=zoom.origin;break;}}
 camera.style.transform='scale('+scale+')';camera.style.transformOrigin=origin;
 overlays.forEach((overlay,i)=>{
  const node=document.getElementById('overlay-'+i);const visible=time>=overlay.start&&time<overlay.end;const fade=Math.min(.16,(overlay.end-overlay.start)/3);const opacity=visible?Math.max(0,Math.min(1,(time-overlay.start)/fade,(overlay.end-time)/fade)):0;
  node.style.visibility=visible?'visible':'hidden';node.style.opacity=String(opacity);node.style.transform='translateY('+((1-opacity)*16)+'px)';
  if(overlay.kind==='counter'){const progress=Math.max(0,Math.min(1,(time-overlay.start)/Math.min(.8,overlay.end-overlay.start)));const value=overlay.valueFrom+(overlay.valueTo-overlay.valueFrom)*progress;const decimals=Number.isInteger(overlay.valueFrom)&&Number.isInteger(overlay.valueTo)?0:2;document.getElementById('counter-'+i).textContent=value.toFixed(decimals)+overlay.suffix;}
 });
}
window.addEventListener('hf-seek',event=>renderAt(event.detail.time));renderAt(0);
window.__timelines=window.__timelines||{};window.__timelines.main=tl;
})();
</script></body></html>`;
}

export async function renderVideo({ source, words, duration, width, height, brolls = [], plan, dir }, config = {}) {
  const outputDir = await ensureMediaDir(dir, config);
  const projectDir = await ensureMediaDir(join(outputDir, 'composition'), config);
  const assets = await ensureMediaDir(join(projectDir, 'assets'), config);
  const html = buildComposition({ words, duration, width, height, brolls, plan });
  await copyFile(resolve(source), join(assets, 'source.mp4'));
  for (const [index, broll] of brolls.entries()) {
    const metadata = await probe(broll.path, config);
    if (metadata.duration + .04 < broll.duration) throw new Error(`B-roll ${index} is shorter than its planned duration`);
    await copyFile(resolve(broll.path), join(assets, `broll-${index}.mp4`));
  }
  await copyFile(require.resolve('gsap/dist/gsap.min.js'), join(assets, 'gsap.min.js'));
  const rootDir=resolve(config.rootDir || dirname(dirname(fileURLToPath(import.meta.url))));
  if(plan?.visualStyle==='kavion-clavicular-v1'){
    for(const font of ['LiberationSans-Bold.ttf','LiberationSerif-Italic.ttf'])await copyFile(join(rootDir,'public/fonts',font),join(assets,font));
    for(const sound of Object.values(REFERENCE_SOUNDS))await copyFile(join(rootDir,'assets/sfx',sound.file),join(assets,sound.file));
  }else await copyFile(join(rootDir,'public/fonts/InterVariable.woff2'), join(assets, 'InterVariable.woff2'));
  await writeFile(join(projectDir, 'index.html'), html);
  await writeFile(join(projectDir, 'timeline.json'), JSON.stringify({words,duration,width,height,brolls:brolls.map(({start,duration},i)=>({path:`assets/broll-${i}.mp4`,start,duration})),plan:plan||null,recipe:plan?.visualStyle==='kavion-clavicular-v1'?'kavion-astra-v3':plan?'kavion-astra-v2':'kavion-captions-v1'},null,2));
  const executable = config.hyperframesPath || require.resolve('hyperframes/package.json').replace(/package\.json$/, 'bin/hyperframes.mjs');
  const isScript = /\.m?js$/.test(executable);
  const binary = isScript ? process.execPath : executable;
  const prefix = isScript ? [executable] : [];
  // Verified against pinned HyperFrames 0.8.186. Ten-second streaming segments
  // bound browser growth; resumes validate the composition/settings fingerprint.
  const env = {DO_NOT_TRACK:'1',PRODUCER_LOW_MEMORY_MODE:'true',PRODUCER_FRAME_DATA_URI_CACHE_LIMIT:'32',PRODUCER_FRAME_DATA_URI_CACHE_BYTES_MB:'64',HF_SEGMENTED_CAPTURE:'true',HF_SEGMENT_FRAMES:'300',HF_SEGMENT_BROWSER_RECYCLE:'1'};
  if (config.ffmpegPath?.includes('/')) env.HYPERFRAMES_FFMPEG_PATH = resolve(config.ffmpegPath);
  if (config.ffprobePath?.includes('/')) env.HYPERFRAMES_FFPROBE_PATH = resolve(config.ffprobePath);
  if (config.browserExecutablePath) env.HYPERFRAMES_BROWSER_PATH = config.browserExecutablePath;
  const lint = await runMediaCommand(binary, [...prefix, 'lint', projectDir, '--json'], { cwd: projectDir, timeout:60_000, env });
  await writeFile(join(projectDir, 'lint.json'), lint.stdout);
  const pending = join(outputDir, 'final.pending.mp4');
  const final = join(outputDir, 'final.mp4');
  const rendered = await runMediaCommand(binary, [...prefix,'render',projectDir,'-o',pending,'--fps','30','--quality','standard','--workers','1','--low-memory-mode','--sdr','--resume'], {cwd:projectDir,timeout:config.renderTimeoutMs||1_800_000,env});
  await writeFile(join(projectDir, 'render.log'), rendered.stdout + '\n' + rendered.stderr);
  if ((await stat(pending)).size < 100) throw new Error('HyperFrames did not produce an MP4');
  await rename(pending, final);
  return final;
}
