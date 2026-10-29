"""Offline-only faster-whisper runner. Model provisioning is a separate action."""
import hashlib
import importlib.util
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import tempfile


def check(settings):
    if importlib.util.find_spec("faster_whisper") is None:
        return {"ready": False, "detail": "Falta faster-whisper local; instalá scripts/requirements-local-transcription.txt en el Python configurado."}
    root = Path(settings["modelPath"])
    required = [root / name for name in ("model.bin", "config.json", "tokenizer.json")]
    if not all(path.is_file() and path.stat().st_size for path in required):
        return {"ready": False, "detail": f"Falta el modelo Whisper {settings['model']} local completo en {root}. Instalalo antes de procesar; no se descargará automáticamente."}
    signature = [(path.name, path.stat().st_size, path.stat().st_mtime_ns) for path in required]
    return {"ready": True, "version": importlib.metadata.version("faster-whisper"), "modelFingerprint": hashlib.sha256(json.dumps(signature).encode()).hexdigest()}


def transcribe(request):
    status = check(request)
    if not status["ready"]:
        raise RuntimeError(status["detail"])
    from faster_whisper import WhisperModel
    if request["device"] not in ("cpu", "cuda") or request["computeType"] not in ("int8", "float32", "float16", "int8_float16"):
        raise ValueError("Dispositivo o precisión de Whisper no válidos.")
    if not isinstance(request["threads"], int) or not 1 <= request["threads"] <= 16:
        raise ValueError("Cantidad de threads inválida.")
    model = WhisperModel(request["modelPath"], device=request["device"], compute_type=request["computeType"], cpu_threads=request["threads"], num_workers=1, local_files_only=True)
    segments, info = model.transcribe(request["source"], language="es", beam_size=5, word_timestamps=True, vad_filter=True, condition_on_previous_text=True)
    words = [{"text": word.word.strip(), "start": word.start, "end": word.end} for segment in segments for word in (segment.words or [])]
    payload = {"words": words, "duration": info.duration, "language": info.language, "model": request["model"], "device": request["device"], "compute_type": request["computeType"], "version": status["version"]}
    output = Path(request["output"])
    fd, temporary = tempfile.mkstemp(dir=output.parent, prefix=output.name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False)
        os.replace(temporary, output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1")
    if sys.argv[1] == "check":
        print(json.dumps(check(json.loads(sys.argv[2])), ensure_ascii=False))
    elif sys.argv[1] == "transcribe":
        transcribe(json.loads(Path(sys.argv[2]).read_text(encoding="utf-8")))
    else:
        raise ValueError("Operación local desconocida.")
