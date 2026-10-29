import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {mkdtemp,writeFile,copyFile,mkdir,rm,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const composition = await import('../src/composition.mjs').catch(() => ({}));

test('composition escapes transcript markup and retains original orientation', () => {
  assert.equal(typeof composition.buildComposition, 'function');
  const html = composition.buildComposition({ words: [{text:'</script><img src=x onerror=alert(1)>',start:0.1,end:0.8}], duration:1, width:360, height:640, brolls:[] });
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;/script&gt;'));
  assert.ok(html.includes('data-width="360"'));
  assert.ok(html.includes('data-height="640"'));
  assert.ok(html.includes('data-has-audio="true"'));
});

test('seekable animation highlights the spoken word and restores backwards seeks', () => {
  assert.equal(typeof composition.buildComposition, 'function');
  const html = composition.buildComposition({ words:[{text:'Hola',start:.1,end:.5},{text:'mundo',start:.55,end:.9}],duration:1,width:640,height:360,brolls:[] });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
  const elements = new Map();
  const listeners = new Map();
  const document = {getElementById(id) { if (!elements.has(id)) elements.set(id,{style:{},classList:{toggle(k,v){this[k]=v;}}}); return elements.get(id); }};
  const timeline = {to(){return this;},fromTo(){return this;},set(){return this;},seek(){return this;}};
  const window = {addEventListener(name,fn){listeners.set(name,fn);}};
  vm.runInNewContext(scripts.join('\n'),{window,document,gsap:{timeline:()=>timeline}});
  const seek = (time)=>listeners.get('hf-seek')({detail:{time}});
  seek(.65);
  assert.equal(elements.get('word-1').classList.active,true);
  assert.equal(elements.get('word-0').classList.active,false);
  seek(.25);
  assert.equal(elements.get('word-0').classList.active,true);
  assert.equal(elements.get('word-1').classList.active,false);
  seek(.99);
  assert.equal(elements.get('word-0').classList.active,false);
  assert.equal(elements.get('word-1').classList.active,false);
});

test('B-roll is muted, bounded to the timeline, and uses only controlled local paths', () => {
  assert.equal(typeof composition.buildComposition, 'function');
  const input = {words:[{text:'Hola',start:0,end:1}],duration:2,width:640,height:360};
  const html = composition.buildComposition({...input,brolls:[{start:1,duration:1}]});
  assert.match(html, /id="broll-0"[^>]*muted/);
  assert.ok(html.includes('assets/broll-0.mp4'));
  assert.throws(()=>composition.buildComposition({...input,brolls:[{start:1.5,duration:1}]}), /B-roll|duration/i);
});

const creativeWords=['Tardás','3','segundos','y','ahorrás','2','horas.'].map((text,i)=>({text,start:i*.5,end:i*.5+.4}));
const creativePlan=()=>({creativeIntent:'Comparar tiempo invertido y ahorrado con una cifra clara.',captionGroups:[{startWord:0,endWord:2,emphasis:[1],position:'lower'},{startWord:3,endWord:6,emphasis:[5],position:'lower'}],zooms:[{startWord:1,endWord:2,scale:1.15,position:'upper'}],overlays:[{kind:'comparison',startWord:1,endWord:6,text:'3 segundos',secondaryText:'2 horas',valueFrom:0,valueTo:0,suffix:'',position:'upper',evidenceStartWord:1,evidenceEndWord:6}],brolls:[{start:0,duration:1,prompt:'Close up of a clock beside a computer',quote:'Tardás 3'}]});
const creativeInput=()=>({words:creativeWords,duration:3.5,width:1080,height:1920,brolls:[{start:0,duration:1}],plan:creativePlan()});
function executeComposition(html){
 const elements=new Map(),listeners=new Map();
 const document={getElementById(id){if(!elements.has(id))elements.set(id,{textContent:'',style:{},classList:{toggle(k,v){this[k]=v;}}});return elements.get(id);}};
 const timeline={to(){return this;},fromTo(){return this;},set(){return this;},seek(){return this;}};
 const window={addEventListener(name,fn){listeners.set(name,fn);}};
 vm.runInNewContext([...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n'),{window,document,gsap:{timeline:()=>timeline}});
 return {elements,seek:time=>listeners.get('hf-seek')({detail:{time}})};
}
test('Astra choices compile to exact caption groups, emphasis and semantic comparisons',()=>{
 const html=composition.buildComposition(creativeInput());
 assert.match(html,/class="[^"]*overlay-comparison/);
 assert.ok(html.includes('3 segundos'));assert.ok(html.includes('2 horas'));
 assert.equal([...html.matchAll(/id="caption-\d+"/g)].length,2);
 assert.match(html,/id="word-5" class="word emphasis"/);
 const changed=creativePlan();changed.overlays=[{...changed.overlays[0],kind:'headline',text:'Tiempo recuperado',secondaryText:''}];
 const other=composition.buildComposition({...creativeInput(),plan:changed});
 assert.ok(other.includes('Tiempo recuperado'));assert.ok(!other.includes('overlay-comparison"'));
});
test('planned zooms and numeric counters restore deterministic state when seeking backwards',()=>{
 const plan=creativePlan();plan.overlays=[{...plan.overlays[0],kind:'counter',text:'Horas ahorradas',secondaryText:'',valueFrom:0,valueTo:2,suffix:' horas'}];
 const {elements,seek}=executeComposition(composition.buildComposition({...creativeInput(),plan}));
 seek(3.2);assert.equal(elements.get('counter-0')?.textContent,'2 horas');
 seek(.8);assert.equal(elements.get('counter-0')?.textContent,'1 horas');assert.match(elements.get('camera').style.transform,/scale\(1\.15\)/);
 seek(0);assert.equal(elements.get('counter-0')?.textContent,'0 horas');assert.equal(elements.get('camera').style.transform,'scale(1)');
});
test('dynamic overlay text cannot execute markup or terminate the generated script',()=>{
 const plan=creativePlan();plan.overlays=[{...plan.overlays[0],kind:'headline',text:'</script><img src=x onerror=alert()>',secondaryText:''}];
 const html=composition.buildComposition({...creativeInput(),plan});
 assert.ok(!html.includes('<img src=x'));assert.ok(html.includes('&lt;/script&gt;&lt;img'));
 assert.doesNotThrow(()=>executeComposition(html));
});
test('planned rendering refuses invalid creative choices and mismatched generated assets',()=>{
 const input=creativeInput();
 assert.throws(()=>composition.buildComposition({...input,plan:{...input.plan,captionGroups:[]}}),/Subtítulos/);
 assert.throws(()=>composition.buildComposition({...input,brolls:[]}),/B-roll/);
});
test('counter suffixes embedded in script data stay inert text',()=>{
 const plan=creativePlan();plan.overlays=[{...plan.overlays[0],kind:'counter',text:'Horas ahorradas',secondaryText:'',valueFrom:0,valueTo:2,suffix:'</script><svg>'}];
 const html=composition.buildComposition({...creativeInput(),plan});
 const {elements,seek}=executeComposition(html);seek(2);
 assert.equal(elements.get('counter-0').textContent,'2</script><svg>');
 assert.ok(!html.includes('<svg>'));assert.ok(html.includes('\\u003c/script\\u003e'));
});

const browserCache=path.join(os.homedir(),'.cache/hyperframes/chrome/chrome-headless-shell');
const cachedBrowsers=await readdir(browserCache,{recursive:true}).catch(()=>[]);
const browserExecutable=process.env.HYPERFRAMES_BROWSER_PATH||process.env.PUPPETEER_EXECUTABLE_PATH||cachedBrowsers.filter(file=>file.endsWith('/chrome-headless-shell')).map(file=>path.join(browserCache,file)).sort().at(-1);
test('rendered portrait caption words and backgrounds stay inside the social safe band', {skip:!browserExecutable}, async()=>{
 const {chromium}=await import('playwright');
 const require=createRequire(import.meta.url);
 const dir=await mkdtemp(path.join(os.tmpdir(),'kavion-caption-bounds-'));
 const browser=await chromium.launch({headless:true,executablePath:browserExecutable,args:['--no-sandbox','--disable-dev-shm-usage','--renderer-process-limit=1']});
 try{
  await mkdir(path.join(dir,'assets'));
  await copyFile(require.resolve('gsap/dist/gsap.min.js'),path.join(dir,'assets/gsap.min.js'));
  await copyFile(new URL('../public/fonts/InterVariable.woff2',import.meta.url),path.join(dir,'assets/InterVariable.woff2'));
  for(const [width,height] of [[1080,1920],[360,640]]){
   await writeFile(path.join(dir,'index.html'),composition.buildComposition({...creativeInput(),width,height}));
   const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
   await page.goto(pathToFileURL(path.join(dir,'index.html')).href);
   await page.evaluate(async()=>{await document.fonts.ready;window.dispatchEvent(new CustomEvent('hf-seek',{detail:{time:2.7}}));});
   const boxes=await page.locator('.caption-inner,.word').evaluateAll(nodes=>nodes.filter(n=>getComputedStyle(n).visibility==='visible').map(n=>({text:n.textContent,...n.getBoundingClientRect().toJSON()})));
   assert.ok(boxes.length>=5,'The actual caption group must be visible for this check');
   for(const box of boxes){
    assert.ok(box.top>=height*168/1920,`Caption above safe band: ${JSON.stringify(box)}`);
    assert.ok(box.bottom<=height*1330/1920,`Caption below safe band: ${JSON.stringify(box)}`);
    assert.ok(box.left>=width*.08&&box.right<=width*.92,`Caption outside horizontal safe margin: ${JSON.stringify(box)}`);
   }
   await page.close();
  }
 }finally{await browser.close();await rm(dir,{recursive:true,force:true});}
});
