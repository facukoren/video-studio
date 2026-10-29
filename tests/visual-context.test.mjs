import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareVisualContext,selectReviewTimes,prepareReviewFrames} from '../src/visual-context.mjs';
import {loadConfig} from '../src/config.mjs';
import {runMediaCommand} from '../src/media.mjs';

test('a missing reference stops before claiming visual guidance',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'kavion-visual-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await assert.rejects(prepareVisualContext('source.mp4',dir,{dataDir:dir,referenceVideoPath:join(dir,'missing.mp4')}),e=>e.needsAttention&&/referencia/i.test(e.message));
});
test('review samples include each scene and B-roll with bounded valid timestamps',()=>{
 const words=Array.from({length:20},(_,i)=>({text:'hola',start:i,end:i+.8}));
 const plan={scenes:[{startWord:2,endWord:5},{startWord:10,endWord:15}],overlays:[{startWord:17,endWord:18}],brolls:[{start:6,duration:3}]};
 const times=selectReviewTimes(20,plan,words);
 assert.ok(times.includes(3.9));assert.ok(times.includes(12.9));assert.ok(times.includes(7.5));
 assert.ok(times.every(t=>t>=0&&t<20));assert.ok(times.length<=24);assert.equal(new Set(times).size,times.length);
});
test('real image extraction records reference/source hashes and changes with source bytes',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'kavion-visual-real-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const c={...loadConfig({DATA_DIR:dir}),visualFramesRemote:false},source=join(dir,'source.mp4'),ref=join(dir,'ref.mp4');
 await runMediaCommand(c.ffmpegPath,['-y','-v','error','-f','lavfi','-i','testsrc2=size=120x200:rate=10:duration=1','-c:v','libx264','-threads','1',source]);
 await writeFile(ref,await readFile(source));c.referenceVideoPath=ref;
 const v=await prepareVisualContext(source,join(dir,'job'),c);
 assert.equal(v.images.length,2);assert.match(v.reference.sha256,/^[a-f0-9]{64}$/);assert.equal(v.source.sha256,v.reference.sha256);
 assert.equal(v.source.width,120);assert.ok(v.source.samples.every(x=>x<1));
 for(const p of v.images)assert.ok((await readFile(p)).length>1000);
 const cached=await prepareVisualContext(source,join(dir,'job'),c);assert.deepEqual(cached,v);
 await writeFile(v.images[1],Buffer.alloc(2048,0x58));
 await prepareVisualContext(source,join(dir,'job'),c);assert.notEqual((await readFile(v.images[1]))[0],0x58);
 await writeFile(source,Buffer.concat([await readFile(source),Buffer.from('metadata change')]));
 const changed=await prepareVisualContext(source,join(dir,'job'),c);assert.notEqual(changed.source.sha256,v.source.sha256);
 const review=await prepareReviewFrames(source,join(dir,'job'),c,{scenes:[],overlays:[],brolls:[]},[]);
 assert.equal(review.images.length,Math.ceil(review.samples.length/6));assert.match(review.sha256,/^[a-f0-9]{64}$/);
});

test('dense timelines retain both B-rolls and all distinct scene types in the review',()=>{
 const words=Array.from({length:100},(_,i)=>({text:'hola',start:i,end:i+.8}));
 const scenes=Array.from({length:30},(_,i)=>({kind:i===29?'metric':'distribution',startWord:i*2,endWord:i*2+1}));
 const plan={scenes,overlays:[],brolls:[{start:75,duration:3},{start:90,duration:3}]};
 const times=selectReviewTimes(100,plan,words);
 assert.ok(times.includes(76.5));assert.ok(times.includes(91.5));assert.ok(times.includes(58.9));assert.ok(times.length<=24);
});
