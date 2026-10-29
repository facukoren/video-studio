import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const media = await import('../src/media.mjs').catch(() => ({}));
const word = (start, end, text = 'voz') => ({ text, start, end });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('word cut planning keeps 0.29 and 0.30 s pauses and trims a 0.31 s pause', () => {
  assert.equal(typeof media.planCuts, 'function');
  for (const [gap, removed] of [[0.29, 0], [0.30, 0], [0.31, 0.01]]) {
    const duration = 2 + gap;
    const segments = media.planCuts([word(0, 1), word(1 + gap, duration)], duration);
    close(segments.reduce((sum, s) => sum + s.end - s.start, 0), duration - removed);
    assert.equal(segments.length, removed ? 2 : 1);
  }
});

test('leading and trailing silence shorten without removing any part of a word', () => {
  assert.equal(typeof media.planCuts, 'function');
  const segments = media.planCuts([word(2, 3)], 5);
  assert.deepEqual(segments, [{ start: 1.7, end: 3.3, outputStart: 0 }]);
});

test('single continuous speech segment is unchanged', () => {
  assert.equal(typeof media.planCuts, 'function');
  assert.deepEqual(media.planCuts([word(0, 1), word(1, 2)], 2), [{ start: 0, end: 2, outputStart: 0 }]);
});

test('malformed, overlapping, unordered, empty, and out-of-bounds word times fail explicitly', () => {
  assert.equal(typeof media.planCuts, 'function');
  for (const words of [[], [word(-1, 1)], [word(1, 1)], [word(1, Infinity)], [word(0, 3)], [word(0, 1.1), word(1, 2)], [word(1, 2), word(0, 1)], [word(0, 1, '')]]) {
    assert.throws(() => media.planCuts(words, 2), /word|tim|transcri/i);
  }
  assert.throws(() => media.planCuts([word(0, 1)], NaN), /duration/i);
  assert.throws(() => media.planCuts([word(0, 1)], 1, -1), /gap/i);
});

test('remapping preserves exact words and their durations across cuts', () => {
  assert.equal(typeof media.remapWords, 'function');
  const words = [word(1, 1.5, 'Hola'), word(3, 3.5, 'mundo')];
  const result = media.remapWords(words, [{ start: .8, end: 1.65, outputStart: 0 }, { start: 2.85, end: 3.7, outputStart: .85 }]);
  assert.deepEqual(result.map(w => w.text), ['Hola', 'mundo']);
  close(result[0].start, .2); close(result[0].end, .7);
  close(result[1].start, 1); close(result[1].end, 1.5);
  assert.deepEqual(words, [word(1, 1.5, 'Hola'), word(3, 3.5, 'mundo')]);
  assert.throws(() => media.remapWords(words, [{ start: 1.2, end: 3.5, outputStart: 0 }]), /word|cut/i);
});

test('final verification rejects measured pauses over 0.3 seconds', async () => {
  assert.equal(typeof media.verifyVideo, 'function');
  const dir = await mkdtemp(join(tmpdir(), 'kavion-verify-'));
  try {
    const ffprobe = join(dir, 'ffprobe');
    const ffmpeg = join(dir, 'ffmpeg');
    await writeFile(ffprobe, '#!/usr/bin/env node\nconsole.log(JSON.stringify({format:{duration:"2"},streams:[{codec_type:"video",width:320,height:180,codec_name:"h264"},{codec_type:"audio",codec_name:"aac"}]}));\n', {mode:0o755});
    await writeFile(ffmpeg, '#!/usr/bin/env node\nif(process.argv.includes("-af")) process.stderr.write("[silencedetect] silence_start: 0.4\\n[silencedetect] silence_end: 0.71 | silence_duration: 0.31\\n");\n', {mode:0o755});
    const result = await media.verifyVideo(join(dir, 'fixture.mp4'), { ffmpegPath: ffmpeg, ffprobePath: ffprobe, maxSilence: .3 });
    assert.equal(result.ok, false);
    close(result.maxSilence, .31);
    assert.match(result.issues.join(' '), /silenc/i);
  } finally { await rm(dir, {recursive:true, force:true}); }
});

test('sound effects cannot mask a pause in the isolated source voice',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'kavion-voice-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const ffprobe=join(dir,'ffprobe'),ffmpeg=join(dir,'ffmpeg'),voice=join(dir,'voice.mp4');
 await writeFile(ffprobe,'#!/usr/bin/env node\nconsole.log(JSON.stringify({format:{duration:"2"},streams:[{codec_type:"video",width:320,height:180},{codec_type:"audio"}]}));\n',{mode:0o755});
 await writeFile(ffmpeg,'#!/usr/bin/env node\nif(process.argv.includes("-af")&&process.argv.some(a=>a.endsWith("voice.mp4")))process.stderr.write("[silencedetect] silence_start: 0.4\\n[silencedetect] silence_end: 1.1 | silence_duration: 0.7\\n");\n',{mode:0o755});
 const result=await media.verifyVideo(join(dir,'final.mp4'),{ffprobePath:ffprobe,ffmpegPath:ffmpeg,voiceReferencePath:voice,maxSilence:.3});
 assert.equal(result.ok,false);close(result.maxSilence,.7);assert.equal(result.mixedMaxSilence,0);assert.equal(result.voiceReference.checked,true);
});

test('a continuous voice reference cannot hide dropped audio in the rendered mix',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'kavion-dropped-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const ffprobe=join(dir,'ffprobe'),ffmpeg=join(dir,'ffmpeg');
 await writeFile(ffprobe,'#!/usr/bin/env node\nconsole.log(JSON.stringify({format:{duration:"2"},streams:[{codec_type:"video",width:320,height:180},{codec_type:"audio"}]}));\n',{mode:0o755});
 await writeFile(ffmpeg,'#!/usr/bin/env node\nif(process.argv.includes("-af")&&process.argv.some(a=>a.endsWith("final.mp4")))process.stderr.write("[silencedetect] silence_start: 0.4\\n[silencedetect] silence_end: 1.1 | silence_duration: 0.7\\n");\n',{mode:0o755});
 const result=await media.verifyVideo(join(dir,'final.mp4'),{ffprobePath:ffprobe,ffmpegPath:ffmpeg,voiceReferencePath:join(dir,'voice.mp4'),maxSilence:.3});
 assert.equal(result.ok,false);close(result.maxSilence,.7);assert.equal(result.voiceReference.maxSilence,0);
});

async function verifyFixture(metadata, expected) {
  const dir = await mkdtemp(join(tmpdir(), 'kavion-expected-'));
  try {
    const ffprobePath = join(dir, 'ffprobe'), ffmpegPath = join(dir, 'ffmpeg');
    await writeFile(ffprobePath, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(metadata))});\n`, {mode:0o755});
    await writeFile(ffmpegPath, '#!/usr/bin/env node\nprocess.exit(0);\n', {mode:0o755});
    return await media.verifyVideo(join(dir, 'fixture.mp4'), {ffprobePath,ffmpegPath,...expected});
  } finally {await rm(dir,{recursive:true,force:true});}
}
const videoMetadata = ({duration=3.1,width=360,height=640,audioEnd=duration,videoEnd=duration}={}) => ({format:{duration:String(duration)},streams:[{codec_type:'video',codec_name:'h264',width,height,start_time:'0',duration:String(videoEnd)},{codec_type:'audio',codec_name:'aac',start_time:'0',duration:String(audioEnd)}]});

test('final verification rejects a decodable MP4 truncated against the planned duration', async () => {
  const result = await verifyFixture(videoMetadata({duration:1}), {expectedDuration:3.1});
  assert.equal(result.ok,false);
  assert.match(result.issues.join(' '), /duraci.n.*esperada/i);
});

test('final verification rejects output dimensions that differ from the source', async () => {
  const result = await verifyFixture(videoMetadata({width:640,height:360}), {expectedWidth:360,expectedHeight:640});
  assert.equal(result.ok,false);
  assert.match(result.issues.join(' '), /dimensiones/i);
});

test('final verification independently checks audio and video cover the final word', async () => {
  for (const shortTrack of [{audioEnd:2},{videoEnd:2}]) {
    const result = await verifyFixture(videoMetadata(shortTrack), {expectedDuration:3.1,expectedWordEnd:2.9});
    assert.equal(result.ok,false);
    assert.match(result.issues.join(' '), /última palabra/i);
  }
});

test('final verification permits one frame and AAC rounding without accepting a longer truncation', async () => {
  const expected = {expectedDuration:3.1,expectedWidth:360,expectedHeight:640,expectedWordEnd:3.1};
  const withinTolerance = await verifyFixture(videoMetadata({duration:3.14,audioEnd:3.08,videoEnd:3.1}),expected);
  assert.equal(withinTolerance.ok,true,JSON.stringify(withinTolerance));
  const outsideTolerance = await verifyFixture(videoMetadata({duration:3.19}),expected);
  assert.equal(outsideTolerance.ok,false);
});

const localFfmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const canEncode = true;
test('many cuts do not accumulate audio-to-transcript drift', {skip: !canEncode}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kavion-drift-'));
  try {
    const config = {ffmpegPath:localFfmpeg,ffprobePath:localFfmpeg.replace(/ffmpeg$/, 'ffprobe'),maxSilence:.3};
    const source = join(dir,'source.mp4');
    const words = Array.from({length:8},(_,i)=>word(.57+i*.87,.92+i*.87,`word${i}`));
    const tones = words.map(w=>`between(t,${w.start},${w.end})`).join('+');
    await media.runMediaCommand(config.ffmpegPath,['-y','-v','error','-f','lavfi','-i','color=c=blue:size=128x128:rate=30:duration=7.5','-f','lavfi','-i',`aevalsrc='0.25*sin(2*PI*440*t)*(${tones})':s=48000:d=7.5`,'-c:v','libx264','-c:a','aac','-shortest',source]);
    const cut = await media.cutVideo(source,words,dir,config);
    const silences = await media.detectSilences(cut.path,config);
    assert.equal(silences.length,9);
    for (const [i,w] of cut.words.entries()) assert.ok(Math.abs(silences[i].end-w.start)<.025,`word ${i} drifted ${silences[i].end-w.start} seconds`);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('review removes complete words even when their audio contains no silence', {skip: !canEncode}, async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kavion-reviewed-cut-'));
 try{
  const config={ffmpegPath:localFfmpeg,ffprobePath:localFfmpeg.replace(/ffmpeg$/,'ffprobe')};
  const source=join(dir,'source.mp4');
  await media.runMediaCommand(localFfmpeg,['-y','-v','error','-f','lavfi','-i','color=c=blue:size=128x128:rate=30:duration=3','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=3','-c:v','libx264','-c:a','aac','-shortest',source]);
  const originalWords=[word(0,1,'Primero'),word(1,2,'repetición'),word(2,3,'seguimos')];
  const retained=[originalWords[0],originalWords[2]];
  const result=await media.cutVideo(source,retained,dir,config,{originalWords,review:{cuts:[{startWord:1,endWord:1,reason:'repetición'}]}});
  close(result.duration,2);assert.deepEqual(result.words,[word(0,1,'Primero'),word(1,2,'seguimos')]);
  const metadata=await media.probe(result.path,config);assert.ok(Math.abs(metadata.duration-2)<.04);
  assert.equal(metadata.width,128);assert.equal(metadata.hasAudio,true);
  await assert.rejects(media.cutVideo(source,originalWords,dir,config,{originalWords,review:{cuts:[{startWord:1,endWord:1}]}}),/retenid|revisi.n/i);
  const fractional=[word(0,.713,'Primero'),word(.713,1.847,'repetición'),word(1.847,3,'seguimos')];
  const fractionalCut=await media.cutVideo(source,[fractional[0],fractional[2]],dir,config,{originalWords:fractional,review:{cuts:[{startWord:1,endWord:1}]}});
  close(fractionalCut.duration,1.866);close(fractionalCut.words[1].start,.713);
  const verified=await media.verifyVideo(fractionalCut.path,{...config,expectedDuration:1.866,expectedWordEnd:1.866});assert.equal(verified.ok,true,JSON.stringify(verified));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('bounded cuts preserve HDR color tags and ten-bit samples until SDR rendering', {skip: !canEncode},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kavion-hdr-cut-'));
 try{
  const config={ffmpegPath:localFfmpeg,ffprobePath:localFfmpeg.replace(/ffmpeg$/,'ffprobe')};
  const source=join(dir,'source.mp4');
  await media.runMediaCommand(localFfmpeg,['-y','-v','error','-f','lavfi','-i','color=c=blue:size=128x128:rate=30:duration=1','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=1','-c:v','libx264','-threads','2','-filter_threads','1','-pix_fmt','yuv420p10le','-color_primaries','bt2020','-color_trc','smpte2084','-colorspace','bt2020nc','-c:a','aac','-shortest',source]);
  const inputVideo=(await media.probe(source,config)).streams.find(s=>s.codec_type==='video');
  assert.equal(inputVideo.color_primaries,'bt2020','The generated HDR fixture must carry its source color primaries: '+JSON.stringify(inputVideo));
  const result=await media.cutVideo(source,[word(0,1)],dir,config);
  const video=(await media.probe(result.path,config)).streams.find(s=>s.codec_type==='video');
  assert.equal(video.pix_fmt,'yuv420p10le');assert.equal(video.color_primaries,'bt2020');assert.equal(video.color_transfer,'smpte2084');assert.equal(video.color_space,'bt2020nc');
 }finally{await rm(dir,{recursive:true,force:true});}
});
