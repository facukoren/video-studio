"""Generate original MIT-licensed sound effects; Python stdlib + FFmpeg only."""
from pathlib import Path
import math
import os
import random
import shutil
import struct
import subprocess
import tempfile
import wave

ROOT = Path(__file__).resolve().parents[1]
RATE = 48000
rng = random.Random(20261029)
ffmpeg = os.environ.get('FFMPEG_PATH') or shutil.which('ffmpeg')
if not ffmpeg:
    raise SystemExit('Install FFmpeg or set FFMPEG_PATH.')
output = ROOT / 'assets/sfx'
output.mkdir(parents=True, exist_ok=True)
for name, duration in [('whoosh-short', .45), ('click-soft', .09), ('impact-bass-1', .5)]:
    samples = []
    for i in range(int(RATE * duration)):
        t = i / RATE
        x = t / duration
        if name == 'whoosh-short':
            signal = rng.uniform(-1, 1) * math.sin(math.pi * x) ** 2 * .25
        elif name == 'click-soft':
            signal = math.sin(2 * math.pi * 1800 * t) * math.exp(-90 * t) * .2
        else:
            phase = 2 * math.pi * (48 * t + 12 * (1 - math.exp(-15 * t)))
            signal = math.sin(phase) * math.exp(-10 * t) * .45
        fade = min(1, i / 120, (RATE * duration - i) / 240)
        samples.append(struct.pack('<h', int(max(-1, min(1, signal * fade)) * 32767)))
    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / 'sound.wav'
        with wave.open(str(source), 'wb') as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(RATE)
            wav.writeframes(b''.join(samples))
        subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-i', str(source),
                        '-map_metadata', '-1', '-codec:a', 'libmp3lame', '-b:a', '128k',
                        str(output / f'{name}.mp3')], check=True)
    print(f'Generated {name}.mp3')
