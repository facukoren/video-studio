import { spawn } from 'node:child_process';
import { mkdir, writeFile, rename, realpath, rm } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';

const EPS = 1e-8;
export const SILENCE_THRESHOLD_DB = -35;

// Subprocess arguments are never interpreted by a shell. Kill the process group
// on timeout so a renderer cannot leave Chrome/FFmpeg working after a failed job.
export function runMediaCommand(binary, args, { timeout = 600_000, cwd, env } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, { cwd, env: env ? { ...process.env, ...env } : process.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const append = (old, chunk) => (old + chunk.toString()).slice(-2_000_000);
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`Media operation timed out after ${timeout} ms`));
      if (code !== 0) return reject(new Error(`Media process failed (${code}): ${stderr.slice(-3000) || stdout.slice(-3000)}`));
      resolvePromise({ stdout, stderr });
    });
  });
}

export async function ensureMediaDir(dir, config = {}) {
  const absolute = resolve(dir);
  await mkdir(absolute, { recursive: true });
  if (config.dataDir || config.rootDir) {
    const [root, actual] = await Promise.all([realpath(config.dataDir || config.rootDir), realpath(absolute)]);
    const rel = relative(root, actual);
    if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) throw new Error('Media output directory is outside the configured root');
  }
  return absolute;
}

function validateWords(words, duration = Infinity) {
  if (!Array.isArray(words) || words.length === 0 || words.length > 100_000) throw new Error('A nonempty, bounded word transcript is required');
  let end = 0;
  for (const [i, word] of words.entries()) {
    if (!word || typeof word.text !== 'string' || !word.text.trim() || word.text.length > 2000 || !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < 0 || word.end <= word.start || word.end > duration + EPS || word.start < end - EPS) throw new Error(`Invalid or overlapping word timing at word ${i}`);
    end = word.end;
  }
}

function addOffsets(segments) {
  let outputStart = 0;
  return segments.map(({ start, end }) => {
    const segment = { start, end, outputStart };
    outputStart += end - start;
    return segment;
  });
}

export function planCuts(words, duration, maxGap = 0.3) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid video duration');
  if (!Number.isFinite(maxGap) || maxGap < 0 || maxGap > 10) throw new Error('Invalid maximum gap');
  validateWords(words, duration);
  const segments = [];
  let start = Math.max(0, words[0].start - maxGap);
  for (let i = 1; i < words.length; i++) {
    const previous = words[i - 1], next = words[i];
    if (next.start - previous.end > maxGap + EPS) {
      segments.push({ start, end: previous.end + maxGap / 2 });
      start = next.start - maxGap / 2;
    }
  }
  segments.push({ start, end: Math.min(duration, words.at(-1).end + maxGap) });
  return addOffsets(segments);
}

export function remapWords(words, segments) {
  validateWords(words);
  if (!Array.isArray(segments) || !segments.length) throw new Error('Missing cut segments');
  let sourceEnd = 0, outputEnd = 0;
  for (const segment of segments) {
    if (![segment.start, segment.end, segment.outputStart].every(Number.isFinite) || segment.start < sourceEnd - EPS || segment.end <= segment.start || Math.abs(segment.outputStart - outputEnd) > EPS) throw new Error('Invalid cut segments');
    sourceEnd = segment.end;
    outputEnd += segment.end - segment.start;
  }
  let index = 0;
  return words.map(word => {
    while (index < segments.length && word.start >= segments[index].end - EPS) index++;
    const segment = segments[index];
    if (!segment || word.start < segment.start - EPS || word.end > segment.end + EPS) throw new Error('A cut would remove part of a word');
    const offset = segment.outputStart - segment.start;
    return { ...word, start: Math.max(0, word.start + offset), end: word.end + offset };
  });
}

// An alignment can assign a real pause to the interior of a word. Only this
// acoustic path may compress such timings; ordinary editorial remapping stays
// strict. Every removed part of a retained word must have acoustic evidence.
export function remapWordsAcrossSilences(words, segments, silences) {
  validateWords(words);
  if (!Array.isArray(segments) || !segments.length) throw new Error('Missing cut segments');
  let sourceEnd = 0, outputEnd = 0;
  for (const segment of segments) {
    if (![segment.start, segment.end, segment.outputStart].every(Number.isFinite) || segment.start < sourceEnd - EPS || segment.end <= segment.start || Math.abs(segment.outputStart - outputEnd) > EPS) throw new Error('Invalid cut segments');
    sourceEnd = segment.end;
    outputEnd += segment.end - segment.start;
  }
  if (!Array.isArray(silences) || silences.some(silence => ![silence.start, silence.end].every(Number.isFinite) || silence.start < 0 || silence.end <= silence.start)) throw new Error('Invalid acoustic silence evidence');
  const evidence = mergeRanges(silences);
  const removals = removalsFromSegments(segments, Math.max(sourceEnd, words.at(-1).end));
  const mapTime = time => {
    let low = 0, high = segments.length;
    while (low < high) { const middle = (low + high) >>> 1; if (segments[middle].start <= time) low = middle + 1; else high = middle; }
    const segment = segments[low - 1];
    return segment ? segment.outputStart + Math.min(time - segment.start, segment.end - segment.start) : 0;
  };
  let removalIndex = 0, evidenceIndex = 0;
  const remapped = words.map(word => {
    while (removalIndex < removals.length && removals[removalIndex].end <= word.start + EPS) removalIndex++;
    for (let i = removalIndex; i < removals.length && removals[i].start < word.end - EPS; i++) {
      const start = Math.max(word.start, removals[i].start), end = Math.min(word.end, removals[i].end);
      while (evidenceIndex < evidence.length && evidence[evidenceIndex].end < start - EPS) evidenceIndex++;
      const silence = evidence[evidenceIndex];
      if (!silence || silence.start > start + EPS || silence.end < end - EPS) throw new Error('A cut would remove a word without acoustic silence evidence');
    }
    const start = mapTime(word.start), end = mapTime(word.end);
    if (end - start <= EPS) throw new Error('An acoustic cut would remove an entire word');
    return { ...word, start, end };
  });
  validateWords(remapped, outputEnd);
  return remapped;
}

export async function probe(path, config = {}) {
  const { stdout } = await runMediaCommand(config.ffprobePath || 'ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', resolve(path)], { timeout: 60_000 });
  const data = JSON.parse(stdout);
  const video = data.streams?.find(stream => stream.codec_type === 'video');
  const duration = Number(data.format?.duration ?? video?.duration);
  if (!video || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(video.width) || !Number.isFinite(video.height)) throw new Error('The file has no valid video stream or duration');
  const rotation = Number(video.side_data_list?.find(item => item.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0);
  const swap = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  return { duration, width: swap ? video.height : video.width, height: swap ? video.width : video.height, hasAudio: data.streams.some(stream => stream.codec_type === 'audio'), streams: data.streams, rotation };
}

export async function detectSilences(path, config = {}) {
  const metadata = await probe(path, config);
  if (!metadata.hasAudio) throw new Error('The source has no original audio track');
  const { stderr } = await runMediaCommand(config.ffmpegPath || 'ffmpeg', ['-hide_banner', '-nostdin', '-i', resolve(path), '-map', '0:a:0', '-af', `silencedetect=noise=${SILENCE_THRESHOLD_DB}dB:d=0.01`, '-f', 'null', '-'], { timeout: config.renderTimeoutMs || 600_000 });
  const result = [];
  let start = null;
  for (const match of stderr.matchAll(/silence_(start|end):\s*(-?\d+(?:\.\d+)?)/g)) {
    const time = Math.max(0, Math.min(metadata.duration, Number(match[2])));
    if (match[1] === 'start') start = time;
    else if (start !== null) { if (time > start) result.push({ start, end: time, duration: time - start }); start = null; }
  }
  if (start !== null && metadata.duration > start) result.push({ start, end: metadata.duration, duration: metadata.duration - start });
  return result;
}

function removalsFromSegments(segments, duration) {
  const removals = [];
  let start = 0;
  for (const segment of segments) { if (segment.start > start + EPS) removals.push({ start, end: segment.start }); start = segment.end; }
  if (duration > start + EPS) removals.push({ start, end: duration });
  return removals;
}

function mergeRanges(ranges) {
  const merged = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + EPS) previous.end = Math.max(previous.end, range.end);
    else merged.push({ start: range.start, end: range.end });
  }
  return merged;
}

function subtractRanges(segments, removals) {
  const cuts = mergeRanges(removals);
  return segments.flatMap(segment => {
    const parts = []; let start = segment.start;
    for (const cut of cuts) {
      if (cut.end <= start || cut.start >= segment.end) continue;
      if (cut.start > start + EPS) parts.push({ start, end: cut.start });
      start = Math.max(start, cut.end);
    }
    if (start < segment.end - EPS) parts.push({ start, end: segment.end });
    return parts;
  });
}

function acousticInteriorRemovals(silences, maxSilence, targetGap) {
  const margin = Math.max(.01, targetGap / 2);
  return silences.filter(silence => silence.end - silence.start > maxSilence + EPS).map(silence => ({
    // Round removals inward: no above-threshold sample or edge guard is lost.
    start: Math.ceil((silence.start + margin - EPS) * 30) / 30,
    end: Math.floor((silence.end - margin + EPS) * 30) / 30,
  })).filter(cut => cut.end > cut.start + EPS);
}

function reviewedRemovals(words, originalWords, review, duration) {
  if (!review?.cuts?.length) return [];
  validateWords(originalWords, duration);
  const removed = new Set(), ranges = [];
  for (const cut of review.cuts) {
    if (!Number.isInteger(cut.startWord) || !Number.isInteger(cut.endWord) || cut.startWord < 0 || cut.endWord < cut.startWord || cut.endWord >= originalWords.length) throw new Error('La revisión contiene índices de palabras inválidos.');
    for (let index = cut.startWord; index <= cut.endWord; index++) {
      if (removed.has(index)) throw new Error('La revisión contiene cortes superpuestos.');
      removed.add(index);
    }
    ranges.push({ start: originalWords[cut.startWord].start, end: originalWords[cut.endWord].end });
  }
  const retained = originalWords.filter((_, index) => !removed.has(index));
  if (retained.length !== words.length || retained.some((word, index) => ['text','start','end'].some(key => word[key] !== words[index][key]))) throw new Error('Las palabras retenidas no coinciden con los cortes de la revisión.');
  return ranges.sort((a,b) => a.start-b.start);
}

// Each invocation decodes just one interval. PCM audio is concatenated before
// its only AAC encode, avoiding one encoder priming delay per cut. Video frame
// counts use cumulative rounding so sub-frame edits cannot accumulate drift.
async function encodeSegments(source, segments, metadata, outputDir, target, config) {
  const chunks = await ensureMediaDir(join(outputDir, 'cut-segments'), config);
  const videoFiles = [], audioFiles = [];
  const video = metadata.streams.find(stream => stream.codec_type === 'video');
  const tenBit = /(?:10|12|16)(?:le|be)?$/.test(video.pix_fmt || '') || Number(video.bits_per_raw_sample) > 8;
  const colors = [];
  for (const [field, flag] of [['color_primaries','-color_primaries'],['color_transfer','-color_trc'],['color_space','-colorspace'],['color_range','-color_range']]) {
    if (video[field] && !['unknown','unspecified','reserved'].includes(video[field])) colors.push(flag,video[field]);
  }
  const threads = String(config.mediaThreads || 2), timeout = config.renderTimeoutMs || 600_000;
  try {
    for (const [index, segment] of segments.entries()) {
      const duration = segment.end-segment.start;
      const frames = Math.round((segment.outputStart+duration)*30)-Math.round(segment.outputStart*30);
      const basename = String(index).padStart(6,'0');
      const audioName = `${basename}.wav`, videoName = `${basename}.mkv`;
      const args = ['-y','-hide_banner','-nostdin','-threads',threads,'-ss',String(segment.start),'-i',resolve(source)];
      if (frames > 0) {
        args.push('-map','0:v:0','-an','-vf','setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=0.067,fps=30,setsar=1','-frames:v',String(frames),'-c:v','libx264','-threads',threads,'-filter_threads','1','-preset','fast','-crf','18','-pix_fmt',tenBit?'yuv420p10le':'yuv420p','-g','30',...colors,'-metadata:s:v:0','rotate=0',join(chunks,videoName));
        videoFiles.push(videoName);
      }
      args.push('-map','0:a:0','-vn','-t',String(duration),'-af','asetpts=PTS-STARTPTS','-c:a','pcm_s24le','-ar','48000',join(chunks,audioName));
      audioFiles.push(audioName);
      await runMediaCommand(config.ffmpegPath || 'ffmpeg',args,{timeout});
    }
    if (!videoFiles.length) throw new Error('Los cortes no conservan un cuadro completo de video.');
    const videoList = join(chunks,'video.ffconcat'), audioList = join(chunks,'audio.ffconcat');
    await writeFile(videoList,videoFiles.map(name=>`file '${name}'`).join('\n'));
    await writeFile(audioList,audioFiles.map(name=>`file '${name}'`).join('\n'));
    await runMediaCommand(config.ffmpegPath || 'ffmpeg',['-y','-hide_banner','-nostdin','-threads',threads,'-f','concat','-safe','1','-i',videoList,'-f','concat','-safe','1','-i',audioList,'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','192k','-ar','48000','-movflags','+faststart',target],{timeout});
  } finally { await rm(chunks,{recursive:true,force:true}); }
}

export async function cutVideo(source, words, dir, config = {}, {review, originalWords} = {}) {
  const maxSilence = config.maxSilence ?? .3;
  if (!Number.isFinite(maxSilence) || maxSilence < 0 || maxSilence > 10) throw new Error('Invalid maximum silence gap');
  const metadata = await probe(source, config);
  if (!metadata.hasAudio) throw new Error('The source has no original voice track');
  const outputDir = await ensureMediaDir(dir, config);
  // The 80 ms margin absorbs at most two 30 fps frame boundaries and AAC priming.
  const targetGap = Math.max(0, maxSilence - .08);
  const requested = planCuts(words, metadata.duration, targetGap);
  const editorialRemovals = reviewedRemovals(words, originalWords, review, metadata.duration);
  const silences = await detectSilences(source, config);
  // Acoustic agreement protects untranscribed speech in transcript gap cuts.
  const removals = removalsFromSegments(requested, metadata.duration).flatMap(cut => silences.map(silence => ({ start: Math.max(cut.start, silence.start), end: Math.min(cut.end, silence.end) })).filter(cut => cut.end - cut.start > EPS));
  const kept = [];
  let cursor = 0;
  for (const removal of removals) { if (removal.start > cursor + EPS) kept.push({ start: cursor, end: removal.start }); cursor = Math.max(cursor, removal.end); }
  if (cursor < metadata.duration - EPS) kept.push({ start: cursor, end: metadata.duration });
  // Match cut boundaries to the output frame grid. Otherwise concat pads each
  // audio segment to its longer video segment, accumulating subtitle drift.
  const aligned = [];
  for (const segment of kept) {
    const start = Math.floor((segment.start + EPS) * 30) / 30;
    const end = Math.min(metadata.duration, Math.ceil((segment.end - EPS) * 30) / 30);
    const previous = aligned.at(-1);
    if (previous && start <= previous.end + EPS) previous.end = Math.max(previous.end, end);
    else aligned.push({start,end});
  }
  // Some alignments stretch a word across an audible pause. Compress only the
  // guarded interior of measured silence, even when that overlaps word timing.
  let acousticRemovals = acousticInteriorRemovals(silences, maxSilence, targetGap);
  let segments = addOffsets(subtractRanges(aligned, [...acousticRemovals, ...editorialRemovals]));
  const temporaryPath = join(outputDir, 'cut.pending.mp4');
  const path = join(outputDir, 'cut.mp4');
  for (let attempt = 0; attempt < 2; attempt++) {
    const remapped = remapWordsAcrossSilences(words, segments, silences);
    const duration = segments.reduce((sum, segment) => sum + segment.end - segment.start, 0);
    const acousticTimingRepairs = words.flatMap((word, index) => {
      const removedDuration = word.end - word.start - (remapped[index].end - remapped[index].start);
      return removedDuration > EPS ? [{ index, text: word.text, sourceStart: word.start, sourceEnd: word.end, start: remapped[index].start, end: remapped[index].end, removedDuration }] : [];
    });
    const audit = { segments, words: remapped, duration, editorialRemovals, silenceThresholdDb: SILENCE_THRESHOLD_DB, targetGap, measuredSilences: silences, acousticRemovals, acousticTimingRepairs, encodeAttempts: attempt + 1 };
    await writeFile(join(outputDir, 'cuts.json'), JSON.stringify(audit, null, 2));
    await encodeSegments(source,segments,metadata,outputDir,temporaryPath,config);
    const encodedSilences = await detectSilences(temporaryPath, config);
    const encodedMaxSilence = encodedSilences.reduce((max, silence) => Math.max(max, silence.duration), 0);
    await writeFile(join(outputDir, 'cuts.json'), JSON.stringify({ ...audit, encodedSilences, encodedMaxSilence }, null, 2));
    if (encodedMaxSilence <= maxSilence + EPS) {
      await rename(temporaryPath, path);
      return { path, words: remapped, duration, segments };
    }
    // One bounded retry may trim codec residue, always encoding from the source
    // and requiring the same original acoustic evidence for every new removal.
    const outputCuts = acousticInteriorRemovals(encodedSilences, maxSilence, targetGap);
    const sourceCuts = outputCuts.flatMap(cut => segments.flatMap(segment => {
      const start = Math.max(cut.start, segment.outputStart), end = Math.min(cut.end, segment.outputStart + segment.end - segment.start);
      if (end <= start + EPS) return [];
      const sourceStart = start - segment.outputStart + segment.start, sourceEnd = end - segment.outputStart + segment.start;
      return silences.map(silence => ({ start: Math.ceil((Math.max(sourceStart, silence.start + .01) - EPS) * 30) / 30, end: Math.floor((Math.min(sourceEnd, silence.end - .01) + EPS) * 30) / 30 })).filter(cut => cut.end > cut.start + EPS);
    }));
    const nextSegments = addOffsets(subtractRanges(segments, sourceCuts));
    if (attempt === 1 || nextSegments.reduce((sum, segment) => sum + segment.end - segment.start, 0) >= duration - EPS) {
      await rm(temporaryPath, { force: true });
      throw Object.assign(new Error(`La pausa acústica de ${encodedMaxSilence.toFixed(6)} s no se pudo reducir sin comprometer la voz.`), { code: 'ACOUSTIC_SILENCE_REPAIR_FAILED' });
    }
    acousticRemovals = mergeRanges([...acousticRemovals, ...sourceCuts]);
    segments = nextSegments;
  }
}

export function validateBrollRegions(regions) {
  if (!Array.isArray(regions) || regions.length < 1 || regions.length > 4) throw new Error('Broll repair requires between one and four regions');
  const normalized = regions.map(region => {
    if (!region || Object.keys(region).some(key => !['x', 'y', 'width', 'height', 'start', 'end'].includes(key)) || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(region[key])) || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0 || region.x + region.width > 1 || region.y + region.height > 1) throw new Error('Invalid normalized Broll repair region');
    const timed = Object.hasOwn(region, 'start') || Object.hasOwn(region, 'end');
    if (timed && (!Number.isFinite(region.start) || !Number.isFinite(region.end) || region.start < 0 || region.end <= region.start)) throw new Error('Invalid Broll repair region time window');
    return { x: region.x, y: region.y, width: region.width, height: region.height, ...(timed ? { start: region.start, end: region.end } : {}) };
  });
  // Sum is intentionally conservative for overlapping regions as well: a repair
  // may obscure a small interface, never most of the generated composition.
  if (normalized.reduce((area, region) => area + region.width * region.height, 0) > .65 + EPS) throw new Error('Broll repair region coverage exceeds 65 percent');
  return normalized;
}

export async function repairBrollVideo(source, regions, dir, config = {}) {
  const normalized = validateBrollRegions(regions);
  const path = resolve(dir, 'repaired-broll.mp4');
  const outputPaths = [path, resolve(dir, 'repaired-broll.pending.mp4'), resolve(dir, 'broll-repair.json')];
  if (outputPaths.includes(resolve(source))) throw new Error('Broll repair output would overwrite its source');
  const sourcePath = await realpath(source);
  for (const outputPath of outputPaths) {
    const existingOutput = await realpath(outputPath).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (existingOutput === sourcePath) throw new Error('Broll repair output would overwrite its source');
  }
  const metadata = await probe(sourcePath, config);
  if (normalized.some(region => region.end !== undefined && region.end > metadata.duration + EPS)) throw new Error('Broll repair region time window exceeds the source duration');
  const outputDir = await ensureMediaDir(dir, config);
  const temporaryPath = join(outputDir, 'repaired-broll.pending.mp4');
  const sigma = Math.min(64, Math.max(8, metadata.width * .025));
  const filters = ['[0:v:0]setpts=PTS-STARTPTS,setsar=1,format=yuv444p[base0]'];
  const pixelRegions = [];
  for (const [index, region] of normalized.entries()) {
    const x = Math.floor(region.x * metadata.width), y = Math.floor(region.y * metadata.height);
    const width = Math.min(metadata.width - x, Math.max(1, Math.ceil((region.x + region.width) * metadata.width) - x));
    const height = Math.min(metadata.height - y, Math.max(1, Math.ceil((region.y + region.height) * metadata.height) - y));
    pixelRegions.push({ x, y, width, height });
    filters.push(`[base${index}]split=2[canvas${index}][crop${index}]`);
    filters.push(`[crop${index}]crop=${width}:${height}:${x}:${y}:exact=1,gblur=sigma=${sigma}:steps=2[blur${index}]`);
    const enable = region.start === undefined ? '' : `:enable='between(t,${region.start},${region.end})'`;
    filters.push(`[canvas${index}][blur${index}]overlay=${x}:${y}:format=auto:shortest=1${enable}[base${index + 1}]`);
  }
  const pixelFormat = metadata.width % 2 || metadata.height % 2 ? 'yuv444p' : 'yuv420p';
  filters.push(`[base${normalized.length}]fps=30,format=${pixelFormat}[repaired]`);
  try {
    await runMediaCommand(config.ffmpegPath || 'ffmpeg', ['-y', '-hide_banner', '-nostdin', '-threads', String(config.mediaThreads || 2), '-i', sourcePath, '-filter_complex_threads', '1', '-filter_complex', filters.join(';'), '-map', '[repaired]', '-an', '-t', String(metadata.duration), '-c:v', 'libx264', '-threads', String(config.mediaThreads || 2), '-preset', 'fast', '-crf', '18', '-pix_fmt', pixelFormat, '-metadata:s:v:0', 'rotate=0', '-movflags', '+faststart', temporaryPath], { timeout: config.renderTimeoutMs || 600_000 });
    const repaired = await probe(temporaryPath, config);
    if (repaired.width !== metadata.width || repaired.height !== metadata.height || Math.abs(repaired.duration - metadata.duration) > 1 / 30 + .01) throw new Error('Repaired Broll dimensions or duration differ from the source');
    await writeFile(join(outputDir, 'broll-repair.json'), JSON.stringify({ schemaVersion: 1, method: 'gaussian-blur', regions: normalized, pixelRegions, sigma, width: metadata.width, height: metadata.height, sourceDuration: metadata.duration, outputDuration: repaired.duration, fps: 30 }, null, 2));
    await rename(temporaryPath, path);
    return { path, regions: normalized };
  } finally { await rm(temporaryPath, { force: true }); }
}

export async function verifyVideo(path, config = {}) {
  const issues = [];
  let metadata, silences = [];
  try { metadata = await probe(path, config); } catch (error) { return { ok: false, duration: 0, maxSilence: null, issues: [error.message] }; }
  if (!metadata.hasAudio) issues.push('El MP4 no conserva una pista de voz.');
  if (metadata.width % 2 || metadata.height % 2) issues.push('Las dimensiones del MP4 no son compatibles con H.264.');
  // The renderer may produce a valid but incomplete MP4. Compare it with the
  // planned timeline, allowing only one frame plus AAC packet rounding.
  if (config.expectedDuration !== undefined) {
    if (!Number.isFinite(config.expectedDuration) || config.expectedDuration <= 0) issues.push('La duración esperada no es válida.');
    else if (Math.abs(metadata.duration - config.expectedDuration) > .08 + EPS) issues.push(`La duración de ${metadata.duration.toFixed(3)} s no coincide con la duración esperada de ${config.expectedDuration.toFixed(3)} s.`);
  }
  if ((config.expectedWidth !== undefined && metadata.width !== config.expectedWidth) || (config.expectedHeight !== undefined && metadata.height !== config.expectedHeight)) issues.push('Las dimensiones del MP4 no coinciden con las dimensiones esperadas del original.');
  if (config.expectedWordEnd !== undefined) {
    if (!Number.isFinite(config.expectedWordEnd) || config.expectedWordEnd <= 0) issues.push('El tiempo esperado de la última palabra no es válido.');
    else for (const [type, name] of [['video', 'video'], ['audio', 'voz']]) {
      const stream = metadata.streams.find(item => item.codec_type === type);
      const duration = Number(stream?.duration), start = Number(stream?.start_time ?? 0);
      if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(start)) issues.push(`No se pudo confirmar que la pista de ${name} alcance la última palabra.`);
      else if (start + duration + 1 / 30 + EPS < config.expectedWordEnd) issues.push(`La pista de ${name} termina antes de la última palabra esperada.`);
    }
  }
  try { await runMediaCommand(config.ffmpegPath || 'ffmpeg', ['-v', 'error', '-xerror', '-nostdin', '-i', resolve(path), '-map', '0:v:0', '-map', '0:a:0?', '-f', 'null', '-'], { timeout: config.renderTimeoutMs || 600_000 }); } catch { issues.push('El MP4 no se puede decodificar completamente.'); }
  if (metadata.hasAudio) {
    try { silences = await detectSilences(path, config); } catch { issues.push('No se pudo medir el silencio en la voz final.'); }
  }
  const mixedMaxSilence = silences.reduce((max, silence) => Math.max(max, silence.duration), 0);
  let maxSilence=mixedMaxSilence,voiceReference;
  if(config.voiceReferencePath){
    voiceReference={checked:false};
    try{
      const voice=await probe(config.voiceReferencePath,config);
      if(!voice.hasAudio||Math.abs(voice.duration-metadata.duration)>.08+EPS)throw new Error('La referencia de voz no coincide con la duración del montaje.');
      const voiceSilences=await detectSilences(config.voiceReferencePath,config);
      const voiceMaxSilence=voiceSilences.reduce((max,silence)=>Math.max(max,silence.duration),0);
      maxSilence=Math.max(mixedMaxSilence,voiceMaxSilence);
      voiceReference={checked:true,duration:voice.duration,maxSilence:voiceMaxSilence};
    }catch(error){issues.push(`No se pudo verificar la voz aislada: ${error.message}`);}
  }
  if (maxSilence > (config.maxSilence ?? .3) + EPS) issues.push(`Silencio medido de ${maxSilence.toFixed(6)} s: supera el máximo de ${config.maxSilence ?? .3} s.`);
  return { ok: issues.length === 0, duration: metadata.duration, maxSilence, issues, silenceThresholdDb: SILENCE_THRESHOLD_DB, width: metadata.width, height: metadata.height,...(voiceReference?{voiceReference,mixedMaxSilence}:{}) };
}
