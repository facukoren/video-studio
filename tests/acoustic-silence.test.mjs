import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as media from '../src/media.mjs';

const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
const config = { ffmpegPath, ffprobePath: ffmpegPath.replace(/ffmpeg$/, 'ffprobe'), maxSilence: .3 };
const words = [{ text: 'seguimos', start: 0, end: 1.4 }, { text: 'hablando', start: 1.4, end: 2 }];
const segments = [{ start: 0, end: .6, outputStart: 0 }, { start: 1, end: 2, outputStart: .6 }];

test('acoustic remapping compresses only proven silent portions of a word and keeps strict remapping strict', () => {
  assert.equal(typeof media.remapWordsAcrossSilences, 'function');
  const result = media.remapWordsAcrossSilences(words, segments, [{ start: .5, end: 1.1 }]);
  assert.deepEqual(result.map(word => word.text), ['seguimos', 'hablando']);
  for (const [index, expected] of [[0, [0, 1]], [1, [1, 1.6]]]) {
    assert.ok(Math.abs(result[index].start - expected[0]) < 1e-8);
    assert.ok(Math.abs(result[index].end - expected[1]) < 1e-8);
  }
  assert.throws(() => media.remapWords(words, segments), /word/i);
  assert.throws(() => media.remapWordsAcrossSilences(words, segments, [{ start: .7, end: 1.1 }]), /silenc|word/i);
  assert.throws(() => media.remapWordsAcrossSilences([{ text: 'lost', start: .7, end: .9 }], segments, [{ start: .5, end: 1.1 }]), /word|palabra/i);
  assert.throws(() => media.remapWordsAcrossSilences(words, [{ ...segments[0], outputStart: NaN }], []), /segment/i);
  assert.throws(() => media.remapWordsAcrossSilences(words, segments, [{ start: .5, end: Infinity }]), /silenc/i);
});

test('cutVideo removes an acoustic pause hidden inside a broad word timing without losing speech', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'kavion-acoustic-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'source.mp4');
  await media.runMediaCommand(ffmpegPath, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:size=128x128:rate=30:duration=2', '-f', 'lavfi', '-i', "aevalsrc='0.25*sin(2*PI*440*t)*(lt(t,0.6)+gte(t,1.1))':s=48000:d=2", '-c:v', 'libx264', '-c:a', 'aac', '-shortest', source]);
  const cut = await media.cutVideo(source, words, dir, config);
  const verified = await media.verifyVideo(cut.path, { ...config, expectedDuration: cut.duration, expectedWordEnd: cut.words.at(-1).end });
  assert.equal(verified.ok, true, JSON.stringify(verified));
  assert.ok(cut.duration < 1.8, `Untrimmed duration ${cut.duration}`);
  assert.deepEqual(cut.words.map(word => word.text), ['seguimos', 'hablando']);
  assert.equal(cut.words[0].start, 0);
  assert.ok(cut.words[0].end < 1.2);
  assert.equal(cut.words[0].end, cut.words[1].start);
  assert.ok(Math.abs(cut.words.at(-1).end - cut.duration) < 1e-8);
  // All source time outside the interior of the measured silent region remains.
  assert.equal(cut.segments[0].start, 0);
  assert.equal(cut.segments.at(-1).end, 2);
  for (let i = 1; i < cut.segments.length; i++) {
    assert.ok(cut.segments[i - 1].end > .65);
    assert.ok(cut.segments[i].start < 1.05);
    assert.ok(Math.abs(cut.segments[i - 1].end * 30 - Math.round(cut.segments[i - 1].end * 30)) < 1e-8);
    assert.ok(Math.abs(cut.segments[i].start * 30 - Math.round(cut.segments[i].start * 30)) < 1e-8);
  }
  const audit = JSON.parse(await readFile(join(dir, 'cuts.json'), 'utf8'));
  for (let i = 1; i < cut.segments.length; i++) {
    const start = cut.segments[i - 1].end, end = cut.segments[i].start;
    assert.ok(audit.measuredSilences.some(silence => start >= silence.start + .1 && end <= silence.end - .1), 'A removal lost a source speech sample or its edge guard');
  }
  assert.ok(audit.acousticRemovals.length > 0);
  assert.equal(audit.acousticTimingRepairs[0].text, 'seguimos');
  assert.ok(audit.encodedMaxSilence <= .3);
});

test('unachievable acoustic pause limits fail closed without publishing an unverified cut', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'kavion-acoustic-limit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'source.mp4');
  await media.runMediaCommand(ffmpegPath, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:size=128x128:rate=30:duration=2', '-f', 'lavfi', '-i', "aevalsrc='0.25*sin(2*PI*440*t)*(lt(t,0.6)+gte(t,1.1))':s=48000:d=2", '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', '-shortest', source]);
  await assert.rejects(media.cutVideo(source, words, dir, { ...config, maxSilence: .02 }), error => error.code === 'ACOUSTIC_SILENCE_REPAIR_FAILED' && error.needsAttention !== true);
  await assert.rejects(access(join(dir, 'cut.mp4')));
  const audit = JSON.parse(await readFile(join(dir, 'cuts.json'), 'utf8'));
  assert.ok(audit.encodeAttempts <= 2);
  assert.ok(audit.encodedMaxSilence > .02);
  await assert.rejects(media.cutVideo(source, words, dir, { ...config, maxSilence: 0 }), error => error.code === 'ACOUSTIC_SILENCE_REPAIR_FAILED');
});

test('cutVideo rejects invalid acoustic limits before reading media', async () => {
  for (const maxSilence of [-.1, NaN, Infinity, 10.1]) {
    await assert.rejects(media.cutVideo('/missing-source.mp4', words, '/unused-output', { maxSilence }), /maximum.*gap|maximum.*silence/i);
  }
});
