import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,copyFile,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {buildComposition} from '../src/composition.mjs';
const require=createRequire(import.meta.url);
const words=Array.from({length:40},(_,i)=>({text:i===20?'1000':i===21?'personas':i%2?'cuentas':'Varias',start:i*.5,end:i*.5+.4}));
function input(){return {words,duration:20,width:1080,height:1920,brolls:[{start:18,duration:1}],plan:{version:3,visualStyle:'kavion-clavicular-v1',framing:{focusX:.5,focusY:.3},creativeIntent:'Explicar cómo se distribuye contenido entre varias cuentas.',captionGroups:Array.from({length:20},(_,i)=>({startWord:i*2,endWord:i*2+1,position:'lower',emphasis:[i*2+1]})),zooms:[{startWord:2,endWord:6,scale:1.12,position:'upper'},{startWord:12,endWord:15,scale:1.06,position:'center'}],overlays:[],brolls:[{start:18,duration:1,prompt:'Close up of editing footage at a desk',quote:'Varias cuentas'}],scenes:['distribution','comparison','metric','sequence'].map((kind,i)=>({kind,startWord:i*8+2,endWord:i*8+7,kicker:'ASÍ FUNCIONA',title:kind==='metric'?'Una red entera':'Un stream.',accent:kind==='metric'?'':'Varias cuentas.',items:kind==='metric'?[]:[{label:'Tu contenido',icon:'clip'},{label:'Cuenta A',icon:'profile'},{label:'Cuenta B',icon:'profile'}],value:kind==='metric'?1000:0,unit:kind==='metric'?'personas':'',evidenceStartWord:kind==='metric'?20:i*8+2,evidenceEndWord:kind==='metric'?21:i*8+7})),soundCues:[{word:2,kind:'whoosh',gain:.08},{word:10,kind:'click',gain:.05},{word:18,kind:'impact',gain:.12}]}};}
test('v3 uses reference palette, semantic scenes, local typography and bounded sound tags',()=>{
 const html=buildComposition(input());
 for(const color of ['#F4F3EE','#15191F','#087DBD','#BCEBFA'])assert.ok(html.includes(color));
 for(const kind of ['distribution','comparison','metric','sequence'])assert.match(html,new RegExp('scene-'+kind));
 assert.match(html,/LiberationSerif-Italic.ttf/);assert.match(html,/LiberationSans-Bold.ttf/);
 assert.match(html,/id="sound-0"[^>]+data-volume="0.08"/);
 assert.match(html,/id="source"[^>]+data-has-audio="true"/);
 assert.match(html,/id="broll-0"[^>]+muted/);
 assert.match(html,/distribution-source/);assert.match(html,/distribution-target/);
 assert.match(html,/comparison-divider/);assert.match(html,/metric-value/);assert.match(html,/sequence-step/);
});
test('v3 text remains inert in both markup and serialized state',()=>{
 const data=input();data.plan.scenes[0].title='</script><img src=x>';
 const html=buildComposition(data);assert.ok(!html.includes('<img src=x>'));assert.ok(html.includes('&lt;/script&gt;'));
});
test('reference font and sound assets include redistribution provenance',async()=>{
 for(const name of ['LiberationSans-Bold.ttf','LiberationSerif-Italic.ttf'])assert.ok((await readFile(new URL('../public/fonts/'+name,import.meta.url))).length>10000);
 assert.match(await readFile(new URL('../public/fonts/LIBERATION-LICENSE.txt',import.meta.url),'utf8'),/SIL OPEN FONT LICENSE/);
 for(const name of ['whoosh-short','click-soft','impact-bass-1'])assert.ok((await readFile(new URL('../assets/sfx/'+name+'.mp3',import.meta.url))).length>100);
 assert.match(await readFile(new URL('../assets/sfx/CREDITS.md',import.meta.url),'utf8'),/original procedural sound effects/);
});
const cache=join(homedir(),'.cache/hyperframes/chrome/chrome-headless-shell');
const browserPath=process.env.HYPERFRAMES_BROWSER_PATH||(await readdir(cache,{recursive:true}).catch(()=>[])).filter(p=>p.endsWith('/chrome-headless-shell')).map(p=>join(cache,p)).sort().at(-1);
test('real browser: split/full bounds, caption gap, portrait focus, semantic layouts and reverse seek',{skip:!browserPath},async()=>{
 const {chromium}=await import('playwright');const dir=await mkdtemp(join(tmpdir(),'kavion-reference-'));const browser=await chromium.launch({headless:true,executablePath:browserPath,args:['--no-sandbox','--disable-dev-shm-usage']});
 try{
  await mkdir(join(dir,'assets'));await copyFile(require.resolve('gsap/dist/gsap.min.js'),join(dir,'assets/gsap.min.js'));
  for(const name of ['LiberationSans-Bold.ttf','LiberationSerif-Italic.ttf'])await copyFile(new URL('../public/fonts/'+name,import.meta.url),join(dir,'assets',name));
  for(const [width,height] of [[1080,1920],[360,640],[1920,1080]]){
   await writeFile(join(dir,'index.html'),buildComposition({...input(),width,height}));const page=await browser.newPage({viewport:{width,height}});await page.goto(pathToFileURL(join(dir,'index.html')).href);await page.evaluate(()=>document.fonts.ready);
   const seek=async time=>page.evaluate(t=>window.dispatchEvent(new CustomEvent('hf-seek',{detail:{time:t}})),time);
   const snapshot=()=>page.evaluate(()=>({camera:document.querySelector('#camera').getAttribute('style'),caption:document.querySelector('#caption-1').getAttribute('style'),scene:document.querySelector('#scene-0').getAttribute('style'),motion:document.querySelector('#camera-image').getAttribute('style')}));
   await seek(.95);assert.equal(await page.locator('#caption-0').evaluate(n=>getComputedStyle(n).visibility),'visible');
   await seek(19.95);assert.equal(await page.locator('#caption-19').evaluate(n=>getComputedStyle(n).visibility),'visible');
   await seek(1.45);assert.equal(await page.locator('#caption-1').evaluate(n=>getComputedStyle(n).visibility),'visible');
   await seek(2);const before=await snapshot();
   if(height>width){const panel=await page.locator('#scene-0').boundingBox();assert.ok(Math.abs(panel.height-height*900/1920)<1);const cap=await page.locator('#caption-2').boundingBox();assert.ok(Math.abs(cap.y-height*770/1920)<1);const source=await page.locator('#source').boundingBox();const faceY=source.y+source.height*.3;assert.ok(faceY>panel.height+(height-panel.height)*.25&&faceY<panel.height+(height-panel.height)*.65,'normalized face focus is centered within lower panel');}
   for(const time of [2,6,10,14]){await seek(time);const boxes=await page.locator('.scene-title,.scene-accent,.scene-item,.metric-value,.caption').evaluateAll(nodes=>nodes.filter(n=>getComputedStyle(n).visibility==='visible').map(n=>n.getBoundingClientRect().toJSON()));assert.ok(boxes.length>3);for(const box of boxes)assert.ok(box.x>=0&&box.right<=width+1&&box.y>=0&&box.bottom<=height+1,JSON.stringify({width,height,box}));}
   await seek(17);if(height>width){const cap=await page.locator('#caption-17').boundingBox();assert.ok(Math.abs(cap.y-height*1440/1920)<1);}
   await seek(2);assert.deepEqual(await snapshot(),before);
   await seek(4);const scale=await page.locator('#camera-image').evaluate(n=>n.style.transform);assert.match(scale,/1\.12/,'zoom holds its target after range instead of resetting to 1');
   // Exercise the maximum accepted copy, not just the short happy-path labels.
   await page.evaluate(()=>{document.querySelectorAll('.scene-title,.scene-accent').forEach(n=>n.textContent='W'.repeat(48));document.querySelectorAll('.distribution-targets,.comparison-grid,.sequence-grid').forEach(n=>{while(n.querySelectorAll('.scene-item').length<(n.classList.contains('distribution-targets')?6:7))n.append(n.querySelector('.scene-item').cloneNode(true));});document.querySelectorAll('.scene-item span').forEach(n=>n.textContent='W'.repeat(24));document.querySelector('.metric-value').textContent='1.000.000.000';});
   for(const time of [2,6,10,14]){await seek(time);const boxes=await page.locator('.scene-title,.scene-accent,.scene-item,.metric-value').evaluateAll(nodes=>nodes.filter(n=>getComputedStyle(n).visibility==='visible').map(n=>n.getBoundingClientRect().toJSON()));const splitCaption=await page.locator('#caption-'+Math.floor(time)).boundingBox();for(const box of boxes){assert.ok(box.x>=0&&box.right<=(height>width?width:width*.45)+1,JSON.stringify({longScene:box,width,height}));assert.ok(box.bottom<=splitCaption.y-4*width/1080,JSON.stringify({longScene:box,captionTop:splitCaption.y,width,height}));}}
   await page.close();
  }
 }finally{await browser.close();await rm(dir,{recursive:true,force:true});}
});

test('real browser: pilot diagram labels stay readable and comparison emphasis follows data',{skip:!browserPath},async()=>{
 const {chromium}=await import('playwright'),{buildReferenceComposition}=await import('../src/reference-composition.mjs');
 const dir=await mkdtemp(join(tmpdir(),'kavion-diagram-labels-')),browser=await chromium.launch({headless:true,executablePath:browserPath,args:['--no-sandbox','--disable-dev-shm-usage']});
 try{
  await mkdir(join(dir,'assets'));await copyFile(require.resolve('gsap/dist/gsap.min.js'),join(dir,'assets/gsap.min.js'));
  for(const name of ['LiberationSans-Bold.ttf','LiberationSerif-Italic.ttf'])await copyFile(new URL('../public/fonts/'+name,import.meta.url),join(dir,'assets',name));
  const data=input(),scene=data.plan.scenes[0];
  data.plan.scenes=[
   {...scene,kind:'sequence',title:'Si no aparecés en TikTok',accent:'Parece que sos uno más',items:[{label:'No aparecés en TikTok',icon:'clip'},{label:'Parecés uno más',icon:'profile'}]},
   {...scene,kind:'sequence',startWord:10,endWord:15,title:'Que quieran entrar a tu stream',accent:'Vos querés lo contrario',items:[{label:'La gente',icon:'profile'},{label:'Entrar a tu stream',icon:'play'}]},
   {...scene,kind:'comparison',startWord:18,endWord:23,title:'Si solo tenés una cuenta',accent:'Vas a aparecer mucho menos',items:[{label:'El resto',icon:'profile',emphasis:'prominent'},{label:'Una cuenta',icon:'profile',emphasis:'subdued'}]},
   {...scene,kind:'comparison',startWord:26,endWord:31,title:'Comparación sin énfasis',accent:'',items:[{label:'Una cuenta',icon:'profile'},{label:'El resto',icon:'profile'}]},
  ];
  await writeFile(join(dir,'index.html'),buildReferenceComposition({...data,creative:data.plan}));
  const page=await browser.newPage({viewport:{width:1080,height:1920}});await page.goto(pathToFileURL(join(dir,'index.html')).href);await page.evaluate(()=>document.fonts.ready);
  const seek=async time=>page.evaluate(t=>window.dispatchEvent(new CustomEvent('hf-seek',{detail:{time:t}})),time);
  const labels=()=>page.locator('.scene-item span').evaluateAll(nodes=>nodes.filter(n=>getComputedStyle(n).visibility==='visible').map(n=>({text:n.textContent,size:parseFloat(getComputedStyle(n).fontSize),rect:n.getBoundingClientRect().toJSON(),parent:n.parentElement.getBoundingClientRect().toJSON()})));
  for(const [time,index]of [[2,0],[6,1],[10,2],[14,3],[2,0],[6,1]]){
   await seek(time);const measured=await labels();assert.equal(measured.length,2);
   for(const label of measured){assert.ok(label.size>=32,JSON.stringify(label));assert.ok(label.rect.x>=label.parent.x&&label.rect.right<=label.parent.right+1);assert.ok(label.rect.bottom<770,JSON.stringify(label));}
   assert.ok(measured[0].rect.right<measured[1].rect.x,'diagram labels must not overlap');
   if(process.env.REFERENCE_SCREENSHOT_DIR){await mkdir(process.env.REFERENCE_SCREENSHOT_DIR,{recursive:true});await page.locator('#scene-'+index).screenshot({path:join(process.env.REFERENCE_SCREENSHOT_DIR,`diagram-${index}.png`)});}
  }
  await seek(10);
  const comparison=await page.locator('#scene-2 .scene-item').evaluateAll(nodes=>nodes.map(n=>({labelSize:parseFloat(getComputedStyle(n.querySelector('span')).fontSize),icon:n.querySelector('.icon').getBoundingClientRect().width,bar:n.querySelector('.comparison-reach')?.getBoundingClientRect().width})));
  assert.ok(comparison[0].icon>comparison[1].icon,'explicit prominent first item must be stronger than subdued last item');
  assert.ok(comparison[0].bar>comparison[1].bar,'qualitative reach follows emphasis, not item position');
  assert.equal(comparison[0].labelSize,comparison[1].labelSize,'emphasis must not reduce label readability');
  await seek(14);
  const defaults=await page.locator('#scene-3 .scene-item').evaluateAll(nodes=>nodes.map(n=>({icon:n.querySelector('.icon').getBoundingClientRect().width,bar:n.querySelector('.comparison-reach')?.getBoundingClientRect().width})));
  assert.deepEqual(defaults[0],defaults[1],'omitted emphasis means normal on either side');
  await page.close();
 }finally{await browser.close();await rm(dir,{recursive:true,force:true});}
});
