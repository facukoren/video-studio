"""Deploy only the optional align-only recovery app; never redeploy the ASR app."""
import hashlib
import json
import os
from pathlib import Path
import re
import modal

ROOT = Path(__file__).resolve().parents[1]
app = modal.App('kavion-word-alignment')
inputs = modal.NetworkFileSystem.from_name('kavion-whisperx-inputs', create_if_missing=True)
cache = modal.Volume.from_name('kavion-whisperx-hf-cache', create_if_missing=True)
image = (modal.Image.debian_slim(python_version='3.11')
    .apt_install('ffmpeg', 'git', 'curl')
    .run_commands('python -m pip install --upgrade pip setuptools wheel',
                  'python -m pip install torch==2.8.0 torchaudio==2.8.0',
                  "python -m pip install 'whisperx==3.8.2' 'faster-whisper==1.2.1' 'huggingface-hub==0.36.2'",
                  "python -c \"import nltk; nltk.download('punkt', quiet=True); nltk.download('punkt_tab', quiet=True)\"")
    .pip_install('num2words==0.5.14')
    .add_local_file(ROOT / 'scripts/alignment_words.py', '/opt/kavion-alignment/alignment_words.py', copy=True)
    .add_local_file(ROOT / 'scripts/transcript_payload.py', '/opt/kavion-alignment/transcript_payload.py', copy=True)
    .env({'PYTHONPATH': '/opt/kavion-alignment', 'HF_HOME': '/model-cache/huggingface', 'TORCH_HOME': '/model-cache/torch'}))


@app.function(image=image, include_source=False, gpu='A10', cpu=2, memory=4096, timeout=600,
              network_file_systems={'/inputs': inputs}, volumes={'/model-cache': cache})
def align_words_v1(remote_path, source_hash, raw_hash, payload):
    from alignment_words import CONTRACT, native_alignment, prepare_alignment, require_acoustic_evidence, restore_alignment
    if not re.fullmatch(r'uploads/video-studio-[a-f0-9]{64}/source\.mp4', remote_path):
        raise ValueError('Invalid source path')
    if not all(isinstance(h, str) and re.fullmatch(r'[a-f0-9]{64}', h) for h in (source_hash, raw_hash)):
        raise ValueError('Invalid input hash')
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    if len(raw) > 16 * 1024**2 or hashlib.sha256(raw).hexdigest() != raw_hash:
        raise ValueError('Transcript hash mismatch')
    source = Path('/inputs') / remote_path
    digest = hashlib.sha256()
    with source.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024**2), b''):
            digest.update(chunk)
    if digest.hexdigest() != source_hash:
        raise ValueError('Source hash mismatch')
    import torch
    import whisperx
    audio = whisperx.load_audio(str(source))
    duration = len(audio) / 16000
    plan = prepare_alignment(payload, duration)
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    model, metadata = whisperx.load_align_model(language_code='es', device=device)
    aligned = native_alignment(whisperx.align(plan['segments'], model, metadata, audio, device, return_char_alignments=False))
    try:
        evidence = require_acoustic_evidence(aligned)
        words = restore_alignment(plan, aligned, duration)
    except ValueError as error:
        # Return private diagnostic evidence for the coordinator to cache. Its
        # independent validation rejects this response as a deliverable.
        return {'contract': CONTRACT, 'sourceHash': source_hash, 'rawHash': raw_hash,
                'duration': duration, 'diagnostics': {'reason': str(error), 'alignment': aligned}}
    cache.commit()
    return {'contract': CONTRACT, 'sourceHash': source_hash, 'rawHash': raw_hash,
            'duration': duration, 'words': words, 'acousticEvidence': evidence,
            'model': 'VOXPOPULI_ASR_BASE_10K_ES', 'language': 'es'}
