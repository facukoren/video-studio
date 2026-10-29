"""Deploy the ASR service into your own Modal account; no public HTTP endpoint.

python -m modal deploy scripts/whisperx-modal.py
"""
import os
from pathlib import Path
import re
import modal

app = modal.App('kavion-whisperx-real')
inputs = modal.NetworkFileSystem.from_name('kavion-whisperx-inputs', create_if_missing=True)
cache = modal.Volume.from_name('kavion-whisperx-hf-cache', create_if_missing=True)
image = (modal.Image.from_registry('nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04', add_python='3.11')
    .apt_install('ffmpeg', 'git', 'ca-certificates')
    .pip_install('torch==2.8.0', 'torchaudio==2.8.0', 'whisperx==3.8.2',
                 'faster-whisper==1.2.1', 'huggingface-hub==0.36.2')
    .env({'HF_HOME': '/model-cache/huggingface', 'TORCH_HOME': '/model-cache/torch'}))


@app.function(image=image, include_source=False, gpu='A10', cpu=2, memory=8192, timeout=1200,
              max_containers=1, retries=0,
              network_file_systems={'/inputs': inputs}, volumes={'/model-cache': cache})
def transcribe_file(remote_path, filename, language='es', model_name='large-v3', enable_diarization=False):
    if (not isinstance(remote_path, str) or
            not re.fullmatch(r'uploads/video-studio-[a-f0-9]{64}/source\.mp4', remote_path) or
            filename != 'source.mp4' or language != 'es' or model_name != 'large-v3' or
            enable_diarization is not False):
        raise ValueError('Invalid transcription request')
    source = Path('/inputs') / remote_path
    if source.is_symlink() or not source.is_file() or not 0 < source.stat().st_size <= 2 * 1024**3:
        raise ValueError('Invalid source')
    import gc
    import torch
    import whisperx
    audio = whisperx.load_audio(str(source))
    duration = len(audio) / 16000
    if not 0 < duration <= 600.04:
        raise ValueError('Video must be at most 10 minutes')
    model = whisperx.load_model(model_name, 'cuda', compute_type='float16', language=language,
                               vad_method='silero', download_root='/model-cache/whisper')
    result = model.transcribe(audio, batch_size=8, language=language)
    del model
    gc.collect()
    torch.cuda.empty_cache()
    align_model, metadata = whisperx.load_align_model(language_code=language, device='cuda')
    aligned = whisperx.align(result['segments'], align_model, metadata, audio, 'cuda', return_char_alignments=False)
    cache.commit()
    # Preserve every segment and its text; the coordinator rejects missing words
    # and can request acoustic realignment using the separate recovery app.
    return {'segments': aligned['segments'], 'duration': duration, 'language': language}
