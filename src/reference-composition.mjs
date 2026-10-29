// Trusted reference-style renderer. Every state is derived from an absolute seek
// time; media playback and audio mixing belong exclusively to HyperFrames.
const escape = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const json = value => JSON.stringify(value).replaceAll('<','\\u003c').replaceAll('>','\\u003e').replaceAll('&','\\u0026').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
export const REFERENCE_SOUNDS = Object.freeze({whoosh:{file:'whoosh-short.mp3',duration:.574688},click:{file:'click-soft.mp3',duration:.365688},impact:{file:'impact-bass-1.mp3',duration:2.115906}});
const icon = kind => {
 const shapes={profile:'<circle cx="32" cy="20" r="10" fill="currentColor"/><path d="M12 57v-9c0-20 40-20 40 0v9" fill="currentColor"/>',clip:'<rect x="7" y="10" width="50" height="44" rx="5"/><path d="m27 23 15 9-15 9Z" fill="currentColor"/>',clock:'<circle cx="32" cy="32" r="25"/><path d="M32 15v18l12 8"/>',check:'<path d="m12 33 13 14 28-31"/>',play:'<path d="m20 10 35 22-35 22Z" fill="currentColor"/>'};
 return `<svg class="icon" viewBox="0 0 64 64" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${shapes[kind]}</svg>`;
};
function diagram(scene){
 const emphasis=entry=>['subdued','normal','prominent'].includes(entry.emphasis)?entry.emphasis:'normal';
 const item=(entry,index,cls='')=>`<div class="scene-item ${cls}" data-reveal="${index}" data-emphasis="${emphasis(entry)}">${icon(entry.icon)}<span class="scene-label">${escape(entry.label)}</span>${cls==='comparison-side'?'<div class="comparison-reach" aria-hidden="true"></div>':''}</div>`;
 if(scene.kind==='distribution')return `<div class="distribution-source" data-reveal="0">${icon(scene.items[0].icon)}<span>${escape(scene.items[0].label)}</span></div><div class="distribution-branch"></div><div class="distribution-targets">${scene.items.slice(1).map((entry,i)=>item(entry,i+1,'distribution-target')).join('')}</div>`;
 if(scene.kind==='comparison')return `<div class="comparison-grid">${scene.items.map((entry,i)=>(i?'<span class="comparison-divider">/</span>':'')+item(entry,i,'comparison-side')).join('')}</div>`;
 if(scene.kind==='sequence')return `<div class="sequence-grid">${scene.items.map((entry,i)=>item(entry,i,'sequence-step')).join('')}</div>`;
 return `<div class="metric-value">${escape(new Intl.NumberFormat('es-AR',{maximumFractionDigits:2}).format(scene.value))}</div><div class="metric-unit">${escape(scene.unit)}</div><div class="metric-dots" aria-hidden="true">${'<i></i>'.repeat(40)}</div>`;
}
export function buildReferenceComposition({words,duration,width,height,brolls,creative}){
 const times=entry=>({start:words[entry.startWord].start,end:words[entry.endWord].end});
 const scenes=creative.scenes.map(scene=>({...scene,...times(scene)}));
 const groups=creative.captionGroups.map((group,i)=>{
  const timing=times(group),next=creative.captionGroups[i+1],nextStart=next?words[next.startWord].start:duration;
  if(nextStart-timing.end<=.3+1e-8)timing.end=nextStart;
  return {...group,...timing};
 });
 const overlays=creative.overlays.map(overlay=>({...overlay,...times(overlay)}));
 const zooms=creative.zooms.map(zoom=>({...zoom,...times(zoom)})).sort((a,b)=>a.start-b.start);
 const portrait=height>width;
 const panel={x:0,y:0,width:portrait?width:width*.45,height:portrait?height*900/1920:height};
 const panelScale=Math.min(panel.width/1080,panel.height/900);
 const panelInnerX=(panel.width-1080*panelScale)/2,panelInnerY=portrait?0:(panel.height-900*panelScale)/2;
 const captionSize=(portrait?width:height)*62/1080;
 return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=${width}, height=${height}"><title>Edición Kavion — referencia Clavicular</title><script src="assets/gsap.min.js"></script><style>
@font-face{font-family:ReferenceSans;src:url('assets/LiberationSans-Bold.ttf') format('truetype');font-weight:700;font-display:block}
@font-face{font-family:ReferenceSerif;src:url('assets/LiberationSerif-Italic.ttf') format('truetype');font-style:italic;font-display:block}
:root{--paper:#F4F3EE;--ink:#15191F;--blue:#087DBD;--cyan:#BCEBFA}*{box-sizing:border-box}html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:var(--paper)}#root{position:relative;width:100%;height:100%;overflow:hidden;color:var(--ink);font-family:ReferenceSans,Arial,sans-serif;font-weight:700}
#camera{position:absolute;inset:0;overflow:hidden;background:var(--paper);z-index:1}#camera-image{position:absolute;inset:0;transform-origin:50% 42%}#source{position:absolute;max-width:none}.broll{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:var(--paper);z-index:2}
#graphics{position:absolute;inset:0;z-index:3;pointer-events:none}.scene{position:absolute;left:0;top:0;width:${panel.width}px;height:${panel.height}px;background:var(--paper);overflow:hidden;border-${portrait?'bottom':'right'}:${Math.max(1,width/540)}px solid var(--blue)}.scene-inner{position:absolute;left:${panelInnerX}px;top:${panelInnerY}px;width:1080px;height:900px;transform-origin:0 0;transform:scale(${panelScale})}.scene-content{position:absolute;inset:0;padding:175px 110px 155px}.scene-kicker{font-size:22px;line-height:1.2;letter-spacing:4px;margin-bottom:18px;text-transform:uppercase;color:#48616B}.scene-title{font-size:62px;line-height:1.05;letter-spacing:-2px;overflow-wrap:anywhere}.scene-accent{font-family:ReferenceSerif,Georgia,serif;font-weight:400;font-style:italic;color:var(--blue);font-size:70px;line-height:1.03;letter-spacing:-2px;overflow-wrap:anywhere}.diagram{position:relative;margin-top:40px;height:230px}.icon{width:64px;height:64px;color:var(--blue);flex:none}.scene-item{min-width:0;text-align:center;overflow-wrap:anywhere;font-size:36px;line-height:1.1}.scene-item span{display:block}.scene-item .icon{display:block;margin:0 auto 12px}.distribution-source{height:56px;min-width:350px;max-width:90%;width:max-content;margin:0 auto;background:var(--blue);color:white;border-radius:9px;display:flex;align-items:center;justify-content:center;gap:15px;padding:0 25px;font-size:24px}.distribution-source .icon{width:34px;height:34px;color:white}.distribution-branch{height:35px;margin:0 7%;border-top:3px solid var(--blue);border-left:3px solid var(--blue);border-right:3px solid var(--blue);border-radius:9px 9px 0 0;position:relative;margin-top:20px}.distribution-branch:before{content:'';position:absolute;left:50%;top:-22px;height:20px;border-left:3px solid var(--blue)}.distribution-targets{display:flex;gap:16px}.distribution-target{flex:1;background:#fff;border:2px solid #e1e9e8;border-radius:12px;padding:14px 8px 10px}.distribution-target .icon{height:56px;margin-bottom:8px}.comparison-grid{display:flex;align-items:center;gap:16px;height:100%}.comparison-side{flex:1;padding:20px 5px;font-size:36px}.comparison-reach{width:62%;height:8px;margin:16px auto 0;border-radius:4px;background:var(--blue)}.comparison-side[data-emphasis="subdued"] .icon{width:48px;height:48px;opacity:.6}.comparison-side[data-emphasis="prominent"] .icon{width:88px;height:88px}.comparison-side[data-emphasis="subdued"] .comparison-reach{width:30%;background:#81BBD3}.comparison-side[data-emphasis="prominent"] .comparison-reach{width:90%}.comparison-divider{font-family:ReferenceSerif,serif;font-size:46px;color:var(--blue)}.sequence-grid{display:flex;gap:16px;align-items:center;height:100%}.sequence-step{position:relative;flex:1;background:white;border-radius:10px;padding:20px 6px;border-bottom:4px solid var(--cyan)}.sequence-step:not(:last-child):after{content:'›';position:absolute;right:-15px;top:35%;color:var(--blue);font-size:32px}.scene-metric .scene-content{padding-top:165px}.scene-metric .scene-title{font-size:36px}.scene-metric .scene-accent{font-size:44px}.scene-metric .diagram{height:330px;margin-top:35px;text-align:center}.metric-value{font-size:180px;line-height:1;color:var(--blue);letter-spacing:-8px;font-variant-numeric:tabular-nums}.metric-unit{font-size:30px;letter-spacing:4px;text-transform:uppercase;margin-top:22px}.metric-dots{display:grid;grid-template-columns:repeat(20,1fr);gap:9px;width:650px;margin:38px auto 0}.metric-dots i{height:19px;background:var(--blue);border-radius:3px}
#captions{position:absolute;inset:0;z-index:5;pointer-events:none}.caption{position:absolute;left:10%;width:80%;font-size:${captionSize}px;line-height:1.16;text-align:center;letter-spacing:-.025em;overflow-wrap:anywhere}.caption-inner{display:inline;background:var(--paper);padding:.06em .18em .1em;border-radius:.12em;box-decoration-break:clone;-webkit-box-decoration-break:clone;box-shadow:0 2px 0 #087dbd20}.word{position:relative;display:inline;z-index:0}.word:before{content:'';position:absolute;z-index:-1;left:-.025em;right:-.025em;bottom:0;height:78%;background:var(--cyan);transform:scaleX(var(--mark,0));transform-origin:left center}.word.emphasis{font-family:ReferenceSerif,Georgia,serif;font-style:italic;font-weight:400;color:var(--blue);font-size:1.14em}.word.emphasis:before{height:10%;bottom:.04em}.reference-overlay{position:absolute;left:14%;width:72%;top:11%;text-align:center;font-size:${captionSize}px;line-height:1.03}.overlay-inner{display:block;border-radius:.15em;background:var(--paper);padding:.35em .5em;border-bottom:2px solid var(--blue)}.overlay-label{display:block;font-size:.3em;letter-spacing:.18em;text-transform:uppercase;margin-bottom:.25em}.overlay-value{font-family:ReferenceSerif,Georgia,serif;font-style:italic;font-weight:400;color:var(--blue);overflow-wrap:anywhere}.overlay-comparison{display:flex;gap:.4em;align-items:center;justify-content:center}.overlay-comparison span{flex:1;min-width:0;overflow-wrap:anywhere}
</style></head><body><div id="root" data-composition-id="main" data-root="true" data-width="${width}" data-height="${height}" data-start="0" data-duration="${duration}" data-fps="30">
<div id="camera" data-layout-allow-overflow><div id="camera-image" data-layout-allow-overflow><video id="source" class="clip" src="assets/source.mp4" data-start="0" data-duration="${duration}" data-track-index="0" data-has-audio="true" playsinline></video></div></div>
${brolls.map((clip,i)=>`<video id="broll-${i}" class="clip broll" src="assets/broll-${i}.mp4" data-start="${clip.start}" data-duration="${clip.duration}" data-track-index="1" muted playsinline></video>`).join('\n')}
<div id="graphics" data-track-kind="graphics" data-layout-allow-overlap>${scenes.map((scene,i)=>`<section id="scene-${i}" class="clip scene scene-${scene.kind}" data-start="${scene.start}" data-duration="${scene.end-scene.start}" data-track-index="3"><div class="scene-inner"><div id="scene-content-${i}" class="scene-content"><div class="scene-kicker">${escape(scene.kicker)}</div><div class="scene-title">${escape(scene.title)}</div><div class="scene-accent">${escape(scene.accent)}</div><div class="diagram">${diagram(scene)}</div></div></div></section>`).join('\n')}
${overlays.map((overlay,i)=>`<div id="overlay-${i}" class="clip reference-overlay" data-start="${overlay.start}" data-duration="${overlay.end-overlay.start}" data-track-index="3"><div id="overlay-content-${i}" class="overlay-inner">${overlay.kind==='comparison'?`<div class="overlay-comparison"><span>${escape(overlay.text)}</span><span class="overlay-value">${escape(overlay.secondaryText)}</span></div>`:overlay.kind==='counter'?`<span class="overlay-label">${escape(overlay.text)}</span><span id="counter-${i}" class="overlay-value">${escape(overlay.valueFrom+overlay.suffix)}</span>`:`<span class="overlay-value">${escape(overlay.text)}</span>`}</div></div>`).join('\n')}</div>
<div id="captions" data-track-kind="captions" data-layout-allow-overlap>${groups.map((group,i)=>`<div id="caption-${i}" class="clip caption" data-start="${group.start}" data-duration="${group.end-group.start}" data-track-index="2"><span class="caption-inner">${words.slice(group.startWord,group.endWord+1).map((word,j)=>`<span id="word-${group.startWord+j}" class="word${group.emphasis.includes(group.startWord+j)?' emphasis':''}">${escape(word.text)}</span>`).join(' ')}</span></div>`).join('\n')}</div>
${creative.soundCues.map((cue,i)=>{const sound=REFERENCE_SOUNDS[cue.kind];return `<audio id="sound-${i}" class="clip" src="assets/${sound.file}" data-start="${words[cue.word].start}" data-duration="${Math.min(sound.duration,duration-words[cue.word].start)}" data-volume="${cue.gain}" data-track-index="4"></audio>`;}).join('\n')}
</div><script>(function(){
const words=${json(words)},groups=${json(groups)},scenes=${json(scenes)},zooms=${json(zooms)},overlays=${json(overlays)},brolls=${json(brolls.map(({start,duration})=>({start,duration})))};
const W=${width},H=${height},portrait=${portrait},focus=${json(creative.framing)},panel=${json(panel)},baseCaptionSize=${captionSize};
const byId=id=>document.getElementById(id),clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const tl=gsap.timeline({paused:true});tl.to({},{duration:${duration}},0);
let lastTime=0;
const fitCache=new Map();
function fitScene(node){
 const signature=node.textContent+'|'+document.fonts.status;if(fitCache.get(node)===signature)return;
 const title=node.querySelector('.scene-title'),accent=node.querySelector('.scene-accent'),diagram=node.querySelector('.diagram'),metric=node.querySelector('.metric-value');
 title.style.fontSize='';accent.style.fontSize='';
 // Fit the label itself: sequence arrows and reach decoration may extend
 // beyond a card without indicating text overflow.
 for(const item of node.querySelectorAll('.scene-item')){const label=item.querySelector('.scene-label');label.style.fontSize='';let size=parseFloat(getComputedStyle(label).fontSize);while((item.offsetHeight>230||label.scrollWidth>label.clientWidth+1)&&size>12){size-=1;label.style.fontSize=size+'px';}}
 if(metric){metric.style.fontSize='';let size=180;while(metric.scrollWidth>metric.clientWidth+1&&size>50){size-=4;metric.style.fontSize=size+'px';}}
 let titleSize=parseFloat(getComputedStyle(title).fontSize),accentSize=parseFloat(getComputedStyle(accent).fontSize);
 while(diagram.offsetTop+Math.max(diagram.offsetHeight,diagram.scrollHeight)>735&&(titleSize>24||accentSize>24)){titleSize=Math.max(24,titleSize-2);accentSize=Math.max(24,accentSize-2);title.style.fontSize=titleSize+'px';accent.style.fontSize=accentSize+'px';}
 fitCache.set(node,signature);
}
function renderAt(time){
 lastTime=time;const activeScene=scenes.findIndex(s=>time>=s.start&&time<s.end),split=activeScene>=0;
 const camera=byId('camera'),image=byId('camera-image'),source=byId('source');
 const x=split&&!portrait?panel.width:0,y=split&&portrait?panel.height:0,cw=W-x,ch=H-y;
 camera.style.left=x+'px';camera.style.top=y+'px';camera.style.width=cw+'px';camera.style.height=ch+'px';
 const sw=source.videoWidth||W,sh=source.videoHeight||H;
 // Only a portrait split crops the source. Full frame and landscape retain it.
 const cover=split&&portrait,ratio=cover?Math.max(cw/sw,ch/sh):Math.min(cw/sw,ch/sh),vw=sw*ratio,vh=sh*ratio;
 source.style.width=vw+'px';source.style.height=vh+'px';
 source.style.left=(cover?clamp(cw*.5-focus.focusX*vw,cw-vw,0):(cw-vw)/2)+'px';
 source.style.top=(cover?clamp(ch*.43-focus.focusY*vh,ch-vh,0):(ch-vh)/2)+'px';
 let scale=1,lastStart=0,previous=1;
 for(const zoom of zooms){if(time<zoom.start)break;const progress=clamp((time-zoom.start)/.16,0,1);scale=previous+(zoom.scale-previous)*(1-Math.pow(1-progress,3));previous=zoom.scale;lastStart=zoom.start;}
 const drift=scale>1?clamp((time-lastStart)/8,0,1)*.018:0;
 image.style.transform='translate('+(-drift*cw*.4)+'px,'+(-drift*ch*.25)+'px) scale('+scale+')';
 image.style.transformOrigin=(focus.focusX*100)+'% '+(split?43:focus.focusY*100)+'%';
 scenes.forEach((scene,i)=>{const visible=i===activeScene,node=byId('scene-'+i),content=byId('scene-content-'+i);node.style.visibility=visible?'visible':'hidden';if(visible)fitScene(node);const p=clamp((time-scene.start)/.18,0,1);content.style.opacity=String(p);content.style.transform='translateY('+((1-p)*18)+'px)';node.querySelectorAll('[data-reveal]').forEach(item=>{const q=clamp((time-scene.start-Number(item.dataset.reveal)*.1)/.2,0,1);item.style.opacity=String(q);item.style.transform='translateY('+((1-q)*16)+'px)';});});
 groups.forEach((group,i)=>{const node=byId('caption-'+i),visible=time>=group.start&&time<group.end;node.style.visibility=visible?'visible':'hidden';node.style.left=split&&!portrait?'4.5%':'10%';node.style.width=split&&!portrait?'36%':'80%';node.style.top=(portrait?H*(split?770:1440)/1920:H*(split?.82:.8))+'px';node.style.fontSize=baseCaptionSize+'px';
  // Font-resolved DOM measurement prevents long words or wrapping from leaving
  // the bounded caption area at any output resolution.
  if(visible){let size=baseCaptionSize;const maxHeight=portrait?H*(split?120:310)/1920:H*.16;while((node.scrollWidth>node.clientWidth+1||node.getBoundingClientRect().height>maxHeight)&&size>baseCaptionSize*.38){size-=baseCaptionSize*.04;node.style.fontSize=size+'px';}}
  for(let j=group.startWord;j<=group.endWord;j++){const word=words[j],next=j<group.endWord?words[j+1].start:group.end,active=visible&&time>=word.start&&time<next,span=byId('word-'+j);span.classList.toggle('active',active);span.style.setProperty('--mark',active?String(clamp((time-word.start)/.1,0,1)):'0');}
 });
 overlays.forEach((overlay,i)=>{const visible=time>=overlay.start&&time<overlay.end,node=byId('overlay-'+i),child=byId('overlay-content-'+i);node.style.visibility=visible?'visible':'hidden';const p=clamp((time-overlay.start)/.16,0,1);child.style.opacity=String(p);child.style.transform='translateY('+((1-p)*12)+'px)';if(overlay.kind==='counter'){const q=clamp((time-overlay.start)/.65,0,1);const value=overlay.valueFrom+(overlay.valueTo-overlay.valueFrom)*q;byId('counter-'+i).textContent=value.toFixed(Number.isInteger(overlay.valueTo)&&Number.isInteger(overlay.valueFrom)?0:2)+overlay.suffix;}});
 brolls.forEach((clip,i)=>byId('broll-'+i).style.visibility=time>=clip.start&&time<clip.start+clip.duration?'visible':'hidden');
}
window.addEventListener('hf-seek',event=>renderAt(event.detail.time));byId('source').addEventListener('loadedmetadata',()=>renderAt(lastTime));document.fonts.ready.then(()=>renderAt(lastTime));renderAt(0);window.__timelines=window.__timelines||{};window.__timelines.main=tl;
})();</script></body></html>`;
}
