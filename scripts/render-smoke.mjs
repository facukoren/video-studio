import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cutVideo, probe, verifyVideo, runMediaCommand } from '../src/media.mjs';
import { renderVideo } from '../src/composition.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(process.env.SMOKE_DIR || join(rootDir, 'runtime/render-smoke'));
await mkdir(dir, { recursive: true });
const config = {
  rootDir,
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
  hyperframesPath: process.env.HYPERFRAMES_PATH || join(rootDir, 'node_modules/hyperframes/bin/hyperframes.mjs'),
  maxSilence: .3,
  renderTimeoutMs: 600_000,
};
const source = join(dir, 'synthetic-source.mp4');
const broll = join(dir, 'synthetic-broll.mp4');
// Deliberately synthetic: three tone bursts align exactly with fixture words.
// They test media mechanics and do not claim ASR or editorial quality.
await runMediaCommand(config.ffmpegPath, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30:duration=4', '-f', 'lavfi', '-i', "aevalsrc='0.25*sin(2*PI*440*t)*(between(t,0.5,1.2)+between(t,2.0,2.7)+between(t,3.0,3.7))':s=48000:d=4", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', '-b:a', '192k', '-shortest', source]);
await runMediaCommand(config.ffmpegPath, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x2d70e7:size=360x640:rate=30:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', broll]);
const words = [{text:'Prueba',start:.5,end:1.2},{text:'de',start:2,end:2.7},{text:'video.',start:3,end:3.7}];
const cut = await cutVideo(source, words, dir, config);
assert.equal(cut.words.length, 3);
assert.ok(cut.duration < 3.2);
const cutCheck = await verifyVideo(cut.path, config);
assert.equal(cutCheck.ok, true, JSON.stringify(cutCheck));
const final = await renderVideo({source:cut.path,words:cut.words,duration:cut.duration,width:360,height:640,brolls:[{path:broll,start:1,duration:1}],dir},config);
const result = await verifyVideo(final, config);
assert.equal(result.ok, true, JSON.stringify(result));
const metadata = await probe(final, config);
assert.equal(metadata.width, 360); assert.equal(metadata.height, 640); assert.equal(metadata.hasAudio,true);
assert.ok(Math.abs(metadata.duration-cut.duration)<.1,'Final audio/video duration drifted');
for (const [name,time] of [['caption',.6],['broll',1.4],['return',2.5]]) {
  await runMediaCommand(config.ffmpegPath,['-y','-v','error','-ss',String(time),'-i',final,'-frames:v','1',join(dir,`${name}.png`)]);
}
const report = { final, result, cutCheck, words:cut.words, segments:cut.segments, sourceIsSynthetic:true, verifiedAt:new Date().toISOString() };
await writeFile(join(dir,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
