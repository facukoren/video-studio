import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as media from '../src/media.mjs';

const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
const config = { ffmpegPath, ffprobePath: ffmpegPath.replace(/ffmpeg$/, 'ffprobe'), mediaThreads: 1 };

test('Broll blur rejects unsafe normalized regions before accessing a source or output', async () => {
  assert.equal(typeof media.repairBrollVideo, 'function');
  const valid = { x: .1, y: .1, width: .2, height: .2 };
  for (const regions of [null, [], Array(5).fill(valid), [null], [{ ...valid, x: NaN }], [{ ...valid, y: Infinity }], [{ ...valid, width: 0 }], [{ ...valid, height: -.1 }], [{ ...valid, x: -.1 }], [{ ...valid, x: .9 }], [{ ...valid, y: .9 }], [{ x: 0, y: 0, width: 1, height: 1 }], [{ x: 0, y: 0, width: .6, height: .6 }, { x: .4, y: .4, width: .6, height: .6 }]]) {
    await assert.rejects(media.repairBrollVideo('/missing-source.mp4', regions, '/unused-output', config), /region|coverage/i);
  }
});

test('remote Broll repair can validate and clone regions before reading or uploading media', () => {
  assert.equal(typeof media.validateBrollRegions, 'function');
  const input = [{ x: .1, y: .2, width: .3, height: .4 }];
  const result = media.validateBrollRegions(input);
  assert.deepEqual(result, input);
  assert.notEqual(result, input);
  assert.notEqual(result[0], input[0]);
  assert.throws(() => media.validateBrollRegions([{ ...input[0], width: Infinity }]), /region/i);
});

test('Broll time windows validate before media access and retain legacy rectangles', async () => {
  const region = { x: .25, y: .25, width: .5, height: .5 };
  assert.deepEqual(media.validateBrollRegions([{ ...region, start: .3, end: .6 }]), [{ ...region, start: .3, end: .6 }]);
  assert.deepEqual(media.validateBrollRegions([region]), [region]);
  for (const extra of [{ start: .3 }, { end: .6 }, { start: -1, end: .6 }, { start: .6, end: .6 }, { start: .7, end: .6 }, { start: NaN, end: .6 }, { start: .3, end: Infinity }, { start: '0.3', end: .6 }, { accidental: true }]) {
    await assert.rejects(media.repairBrollVideo('/missing-source.mp4', [{ ...region, ...extra }], '/unused-output', config), /region|tim/i);
  }
});

test('Broll repair cannot overwrite its source through any of its output names', async () => {
  const regions = [{ x: .1, y: .1, width: .2, height: .2 }];
  for (const name of ['repaired-broll.mp4', 'repaired-broll.pending.mp4', 'broll-repair.json']) {
    await assert.rejects(media.repairBrollVideo(`/missing/${name}`, regions, '/missing', config), /overwrite.*source/i);
  }
});

test('Broll repair blurs only selected regions while retaining dimensions, duration and the source', async t => {
  assert.equal(typeof media.repairBrollVideo, 'function');
  const dir = await mkdtemp(join(tmpdir(), 'kavion-broll-blur-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'source.mp4');
  await media.runMediaCommand(ffmpegPath, ['-y', '-v', 'error', '-f', 'lavfi', '-i', "nullsrc=size=128x128:rate=30:duration=1,geq=lum='if(mod(floor(X/4)+floor(Y/4),2),220,30)':cb=128:cr=128", '-c:v', 'libx264', '-threads', '1', '-crf', '10', source]);
  const originalBytes = await readFile(source);
  const regions = [{ x: .25, y: .25, width: .5, height: .5 }, { x: .0625, y: .0625, width: .125, height: .125 }];
  const result = await media.repairBrollVideo(source, regions, join(dir, 'repair'), config);
  assert.deepEqual(result.regions, regions);
  assert.deepEqual(await readFile(source), originalBytes);
  const metadata = await media.probe(result.path, config);
  assert.equal(metadata.width, 128);
  assert.equal(metadata.height, 128);
  assert.ok(Math.abs(metadata.duration - 1) <= 1 / 30);
  assert.equal(metadata.streams.find(stream => stream.codec_type === 'video').r_frame_rate, '30/1');
  const audit = JSON.parse(await readFile(join(dir, 'repair', 'broll-repair.json'), 'utf8'));
  assert.deepEqual(audit.regions, regions);
  assert.equal(audit.width, 128);
  assert.equal(audit.height, 128);
  assert.equal(audit.fps, 30);
  assert.ok(Math.abs(audit.outputDuration - audit.sourceDuration) <= 1 / 30);
  const frames = [];
  for (const [index, path] of [source, result.path].entries()) {
    const frame = join(dir, `frame-${index}.gray`);
    await media.runMediaCommand(ffmpegPath, ['-y', '-v', 'error', '-i', path, '-frames:v', '1', '-pix_fmt', 'gray', '-threads', '1', '-f', 'rawvideo', frame]);
    frames.push(await readFile(frame));
  }
  let inside = 0, insideCount = 0, outside = 0, outsideCount = 0;
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const difference = Math.abs(frames[0][y * 128 + x] - frames[1][y * 128 + x]);
    if (x >= 36 && x < 92 && y >= 36 && y < 92) { inside += difference; insideCount++; }
    else if ((x < 28 || x >= 100 || y < 28 || y >= 100) && !(x < 28 && y < 28)) { outside += difference; outsideCount++; }
  }
  assert.ok(inside / insideCount > 40, `Region was not blurred: ${inside / insideCount}`);
  assert.ok(outside / outsideCount < 4, `Pixels outside the repair changed: ${outside / outsideCount}`);
});

test('Broll repair limits its blur to the selected time window and rejects windows beyond the clip', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'kavion-broll-window-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'source.mp4');
  await media.runMediaCommand(ffmpegPath, ['-y', '-v', 'error', '-f', 'lavfi', '-i', "nullsrc=size=128x128:rate=30:duration=1,geq=lum='if(mod(floor(X/4)+floor(Y/4),2),220,30)':cb=128:cr=128", '-c:v', 'libx264', '-threads', '1', '-crf', '10', source]);
  const sourceBytes = await readFile(source);
  const region = { x: .25, y: .25, width: .5, height: .5, start: .3, end: .6 };
  const result = await media.repairBrollVideo(source, [region], join(dir, 'repair'), config);
  assert.deepEqual(result.regions, [region]);
  let reference;
  for (const [index, { path, time }] of [{ path: source, time: .1 }, ...[.1, .5, .8].map(time => ({ path: result.path, time }))].entries()) {
    const frame = join(dir, `window-${index}.gray`);
    await media.runMediaCommand(ffmpegPath, ['-y', '-v', 'error', '-ss', String(time), '-i', path, '-frames:v', '1', '-pix_fmt', 'gray', '-threads', '1', '-f', 'rawvideo', frame]);
    const pixels = await readFile(frame);
    if (index === 0) { reference = pixels; continue; }
    let difference = 0, count = 0;
    for (let y = 36; y < 92; y++) for (let x = 36; x < 92; x++) { difference += Math.abs(pixels[y * 128 + x] - reference[y * 128 + x]); count++; }
    if (time === .5) assert.ok(difference / count > 40, `Blur missing inside its window: ${difference / count}`);
    else assert.ok(difference / count < 4, `Blur escaped its window: ${difference / count}`);
  }
  await assert.rejects(media.repairBrollVideo(source, [{ ...region, end: 1.1 }], join(dir, 'invalid'), config), /duration|window|region/i);
  await assert.rejects(access(join(dir, 'invalid')));
  assert.deepEqual(await readFile(source), sourceBytes);
});
