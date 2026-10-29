"""Dedicated HyperFrames runtime and durable local bridge. No provider secrets.

Deploy: python -m modal deploy scripts/media_modal.py
Client: KAVION_MEDIA_CLIENT_MODE=1 python scripts/media_modal.py client REQUEST STATE OUTPUT
"""
from __future__ import annotations
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
import tempfile
import time

APP_NAME = 'kavion-video-studio-media'
VOLUME_NAME = 'kavion-video-studio-media'
ROOT = Path(__file__).resolve().parents[1]
OPERATIONS = {'cut', 'render', 'verify', 'smoke', 'frames', 'repair-broll'}
MAX_SOURCE_BYTES = 2 * 1024**3
MAX_OUTPUT_BYTES = 10 * 1024**3
_build_temp = None
RUNTIME_CONTRACT = 'astra-v3'
RUNTIME_FILES = tuple(json.loads((ROOT / 'scripts/media-runtime.json').read_text())['files'])


def runtime_fingerprint():
    baked = os.environ.get('KAVION_MEDIA_RUNTIME_FINGERPRINT')
    if baked:
        return baked
    digest = hashlib.sha256()
    for name in RUNTIME_FILES:
        digest.update(name.encode())
        digest.update((ROOT / name).read_bytes())
    return digest.hexdigest()


def runtime_function_name():
    return f'run_media_astra_v3_{runtime_fingerprint()[:16]}'



class AttentionError(RuntimeError):
    needs_attention = True


class MediaWaitError(RuntimeError):
    needs_attention = False

    def __init__(self, message, code='MODAL_MEDIA_RUNNING'):
        super().__init__(message)
        self.code = code


def atomic_save(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f'.{path.name}.', dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            json.dump(value, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    directory_fd = os.open(str(path.parent), os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def hash_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def namespace_for(request):
    if request.get('runtimeContract') != RUNTIME_CONTRACT:
        raise ValueError('El contrato del runtime remoto no corresponde a Astra v3.')
    if request.get('runtimeFingerprint') != runtime_fingerprint():
        raise AttentionError('La huella del runtime cambió; conservar el estado y revisar antes de reenviar.')
    if request.get('schema') != 1 or request.get('operation') not in OPERATIONS:
        raise ValueError('Operación remota no válida.')
    for key in ('jobKey', 'requestHash'):
        if not re.fullmatch(r'[a-f0-9]{64}', request.get(key, '')):
            raise ValueError('Identificador remoto no válido.')
    return f"jobs/{request['jobKey']}/{request['operation']}/{request['requestHash']}"


def validate_input_sizes(request):
    # The cut input is the bounded original. Re-encoding may enlarge cut/final
    # files, so render and verify accept the same 10 GiB limit as media outputs.
    limit = MAX_SOURCE_BYTES if request['operation'] == 'cut' else MAX_OUTPUT_BYTES
    for item in request.get('inputs', []):
        size = item.get('size')
        if type(size) is not int or size <= 0 or size > limit:
            raise ValueError(f'El archivo de medios no es válido o supera {limit // 1024**3} GiB.')


def safe_output(root, name):
    if not isinstance(name, str) or '\\' in name:
        raise ValueError('Ruta remota no válida.')
    relative = PurePosixPath(name)
    if relative.is_absolute() or '..' in relative.parts or not relative.parts:
        raise ValueError('Ruta remota fuera del trabajo.')
    result = root.joinpath(*relative.parts)
    if not result.resolve().is_relative_to(root.resolve()):
        raise ValueError('Un enlace local sale del trabajo.')
    return result


def materialize(volume, receipt, request, output_dir):
    namespace = namespace_for(request)
    if receipt.get('runtimeContract') != RUNTIME_CONTRACT or receipt.get('runtimeFingerprint') != request.get('runtimeFingerprint'):
        raise AttentionError('El recibo pertenece a otra huella de runtime; requiere revisión.')
    if receipt.get('requestHash') != request['requestHash'] or receipt.get('operation') != request['operation']:
        raise AttentionError('El resultado remoto no corresponde a este trabajo.')
    if not receipt.get('ok'):
        raise AttentionError(receipt.get('error', 'Falló el procesamiento remoto; revisar antes de repetir.'))
    files = receipt.get('files', [])
    if len(files) > 100 or sum(item.get('size', MAX_OUTPUT_BYTES + 1) for item in files) > MAX_OUTPUT_BYTES:
        raise AttentionError('El resultado remoto excede los límites de descarga.')
    for item in files:
        target = safe_output(output_dir, item['path'])
        if not re.fullmatch(r'[a-f0-9]{64}', item.get('sha256', '')) or not isinstance(item.get('size'), int) or item['size'] < 0:
            raise AttentionError('El manifiesto remoto no es válido.')
        if target.is_file() and target.stat().st_size == item['size'] and hash_file(target) == item['sha256']:
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix=f'.{target.name}.', suffix='.download', dir=target.parent)
        temporary = Path(name)
        digest, count = hashlib.sha256(), 0
        try:
            with os.fdopen(fd, 'wb') as handle:
                for chunk in volume.read_file(f"/{namespace}/outputs/{item['path']}"):
                    count += len(chunk)
                    if count > item['size']:
                        raise AttentionError('La descarga remota supera el tamaño confirmado.')
                    handle.write(chunk)
                    digest.update(chunk)
                handle.flush()
                os.fsync(handle.fileno())
            if count != item['size'] or digest.hexdigest() != item['sha256']:
                raise AttentionError('La descarga remota no coincide con su hash confirmado.')
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    return {'ok': True, 'result': receipt['result'], 'receipt': receipt}


def run_client(request, state_path, output_dir, sdk=None):
    """One submission at most. A lost spawn response requires reconciliation."""
    import fcntl
    state_path, output_dir = Path(state_path), Path(output_dir)
    state_path.parent.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    namespace = namespace_for(request)
    validate_input_sizes(request)
    with state_path.with_suffix('.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise MediaWaitError('Esta operación remota ya está siendo gestionada por otro proceso.', 'MODAL_MEDIA_BUSY')
        state = json.loads(state_path.read_text()) if state_path.exists() else {}
        if state and state.get('requestHash') != request['requestHash']:
            raise AttentionError('La solicitud cambió después de iniciar la operación remota.')
        if state.get('phase') == 'submitting' and not state.get('call_id'):
            raise AttentionError('Envío remoto incierto: falta call_id. Revisar Modal antes de repetir; no se reenviará automáticamente.')
        if sdk is None:
            import modal as sdk
        options = {'environment_name': request['environment']} if request.get('environment') else {}
        volume = sdk.Volume.from_name(request.get('volume', VOLUME_NAME), **options)
        if not state.get('call_id') and not state.get('receipt'):
            function = sdk.Function.from_name(request.get('app', APP_NAME), runtime_function_name(), **options)
            function.hydrate()  # Missing deployment is detected before a pending marker.
            wire = {key: request[key] for key in ('schema', 'runtimeContract', 'runtimeFingerprint', 'operation', 'jobKey', 'requestHash', 'payload')}
            wire['inputs'] = [{key: item[key] for key in ('name', 'size', 'sha256')} for item in request.get('inputs', [])]
            with volume.batch_upload(force=True) as batch:
                for item in request.get('inputs', []):
                    if not re.fullmatch(r'[a-z0-9-]+\.mp4', item['name']):
                        raise ValueError('Nombre de archivo remoto no válido.')
                    path = Path(item['path'])
                    if not path.is_file() or path.stat().st_size != item['size'] or hash_file(path) != item['sha256']:
                        raise AttentionError('El archivo de entrada cambió antes de subirlo.')
                    batch.put_file(str(path), f"/{namespace}/inputs/{item['name']}")
                batch.put_file(io.BytesIO(json.dumps(wire).encode()), f'/{namespace}/request.json')
            state = {'requestHash': request['requestHash'], 'phase': 'submitting', 'namespace': namespace, 'submittedAt': time.time()}
            atomic_save(state_path, state)
            try:
                call = function.spawn(f'/{namespace}/request.json', request['requestHash'])
                call_id = call.object_id
                if not isinstance(call_id, str) or not call_id.startswith('fc-'):
                    raise ValueError('Modal returned no valid call ID')
            except Exception:
                raise AttentionError('Envío remoto incierto; el marcador se conserva y no se repetirá automáticamente.') from None
            state.update(phase='submitted', call_id=call_id)
            atomic_save(state_path, state)
        receipt = state.get('receipt')
        if receipt is None:
            call = sdk.FunctionCall.from_id(state['call_id'])
            deadline = time.monotonic() + min(1800, request.get('timeoutSeconds', 1800))
            while time.monotonic() < deadline:
                try:
                    receipt = call.get(timeout=20)
                    break
                except (sdk.exception.FunctionTimeoutError, sdk.exception.OutputExpiredError) as error:
                    try:
                        chunks, size = [], 0
                        for chunk in volume.read_file(f'/{namespace}/receipt.json'):
                            size += len(chunk)
                            if size > 2 * 1024**2:
                                raise ValueError('Remote receipt too large')
                            chunks.append(chunk)
                        receipt = json.loads(b''.join(chunks))
                        break
                    except Exception:
                        raise AttentionError(f'La ejecución remota terminó o expiró ({type(error).__name__}) sin recibo recuperable; se conserva call_id para revisar.') from None
                except TimeoutError:
                    continue
            if receipt is None:
                raise MediaWaitError('Modal sigue procesando; se conserva call_id para retomar sin volver a enviar.')
            state.update(receipt=receipt, phase='finished')
            atomic_save(state_path, state)
        result = materialize(volume, receipt, request, output_dir)
        state.update(phase='downloaded', downloadedAt=time.time())
        atomic_save(state_path, state)
        return result


def minimal_npm_lock():
    """Retain only the pinned render dependency closure, including optional binaries."""
    original = json.loads((ROOT / 'package-lock.json').read_text())
    packages = original['packages']
    dependencies = {'hyperframes': '0.8.186', 'gsap': '3.14.2'}
    selected = {}
    pending = [f'node_modules/{name}' for name in dependencies]
    while pending:
        path = pending.pop()
        if path in selected:
            continue
        entry = dict(packages[path])
        entry.pop('dev', None)
        entry.pop('devOptional', None)
        selected[path] = entry
        dependency_names = set(entry.get('dependencies', {})) | set(entry.get('optionalDependencies', {})) | set(entry.get('peerDependencies', {}))
        for name in dependency_names:
            cursor, candidates = path, [f'{path}/node_modules/{name}']
            while '/node_modules/' in cursor:
                cursor = cursor.rsplit('/node_modules/', 1)[0]
                candidates.append(f'{cursor}/node_modules/{name}')
            candidates.append(f'node_modules/{name}')
            match = next((candidate for candidate in candidates if candidate in packages), None)
            if match:
                pending.append(match)
            elif name in entry.get('dependencies', {}):
                raise ValueError(f'Missing locked render dependency: {name}')
    manifest = {'name': 'kavion-video-studio-media', 'version': '0.1.0', 'private': True, 'type': 'module', 'dependencies': dependencies}
    lock = {'name': manifest['name'], 'version': manifest['version'], 'lockfileVersion': 3, 'requires': True, 'packages': {'': manifest, **selected}}
    return manifest, lock


def build_app():
    import modal
    global _build_temp, MEDIA_VOLUME
    app = modal.App(APP_NAME)
    MEDIA_VOLUME = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)
    if modal.is_local():
        manifest, lock = minimal_npm_lock()
        _build_temp = tempfile.TemporaryDirectory(prefix='kavion-media-image-')
        build_dir = Path(_build_temp.name)
        (build_dir / 'package.json').write_text(json.dumps(manifest))
        (build_dir / 'package-lock.json').write_text(json.dumps(lock))
        image = (modal.Image.from_registry('node:24.16.0-bookworm-slim', add_python='3.11')
                 .apt_install('ffmpeg', 'chromium', 'ca-certificates', 'fonts-dejavu-core')
                 .add_local_file(build_dir / 'package.json', '/opt/kavion-media/package.json', copy=True)
                 .add_local_file(build_dir / 'package-lock.json', '/opt/kavion-media/package-lock.json', copy=True)
                 .run_commands('cd /opt/kavion-media && npm ci --omit=dev --no-audit --no-fund')
                 .run_commands('ffmpeg -hide_banner -filters 2>/dev/null | grep " zscale "',
                               'ffmpeg -hide_banner -filters 2>/dev/null | grep " tonemap "'))
        for path in RUNTIME_FILES:
            image = image.add_local_file(ROOT / path, f'/opt/kavion-media/{path}', copy=True)
        image = image.env({'KAVION_MEDIA_RUNTIME_FINGERPRINT':runtime_fingerprint(), 'DO_NOT_TRACK': '1', 'HYPERFRAMES_BROWSER_PATH': '/usr/bin/chromium', 'HYPERFRAMES_FFMPEG_PATH': '/usr/bin/ffmpeg', 'HYPERFRAMES_FFPROBE_PATH': '/usr/bin/ffprobe', 'PRODUCER_LOW_MEMORY_MODE': 'true', 'PYTHONPATH': '/opt/kavion-media:/opt/kavion-media/scripts'})
    else:
        image = modal.Image.debian_slim()
    app.function(name=runtime_function_name(), image=image, cpu=(2, 2), memory=(4096, 8192),
                 min_containers=0, max_containers=1, buffer_containers=0,
                 scaledown_window=10, retries=0, timeout=1800, startup_timeout=300,
                 volumes={'/media': MEDIA_VOLUME}, include_source=False)(remote_run)
    return app


def run_supervised(command, *, stdout, stderr, timeout, cwd):
    """Stop detached descendants too, before the remote worker accepts another job."""
    import signal
    import subprocess
    process = subprocess.Popen(command, stdout=stdout, stderr=stderr, cwd=cwd, start_new_session=True)
    try:
        returncode = process.wait(timeout=timeout)
        return subprocess.CompletedProcess(command, returncode)
    except BaseException:
        descendants = {process.pid}
        # Freeze the parent before scanning so it cannot create more children;
        # repeat as newly found Chromium/FFmpeg children may have their own group.
        while True:
            for pid in descendants:
                try:
                    os.kill(pid, signal.SIGSTOP)
                except ProcessLookupError:
                    pass
            before = len(descendants)
            parents = {}
            for entry in Path('/proc').iterdir():
                if not entry.name.isdigit():
                    continue
                try:
                    fields = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
                    parents[int(entry.name)] = int(fields[1])
                except (OSError, ValueError, IndexError):
                    continue
            changed = True
            while changed:
                found = {pid for pid, parent in parents.items() if parent in descendants}
                changed = not found.issubset(descendants)
                descendants.update(found)
            if len(descendants) == before:
                break
        for pid in descendants:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        process.wait()
        raise


def remote_run(control_path, expected_hash):
    import resource
    if not re.fullmatch(r'/jobs/[a-f0-9]{64}/(cut|render|verify|smoke|frames|repair-broll)/[a-f0-9]{64}/request\.json', control_path):
        raise ValueError('Invalid remote control path')
    started = time.monotonic()
    MEDIA_VOLUME.reload()
    request_path = Path('/media' + control_path)
    request = json.loads(request_path.read_text())
    namespace = namespace_for(request)
    if expected_hash != request['requestHash'] or control_path != f'/{namespace}/request.json':
        raise ValueError('Remote request identity mismatch')
    job_dir = request_path.parent
    receipt_path = job_dir / 'receipt.json'
    if receipt_path.exists():
        return json.loads(receipt_path.read_text())
    if (job_dir / 'started.json').exists():
        return {'ok': False, 'operation': request['operation'], 'requestHash': expected_hash, 'error': 'Operación remota iniciada sin resultado confirmado. Requiere revisión; no se vuelve a renderizar.'}
    atomic_save(job_dir / 'started.json', {'startedAt': time.time(), 'requestHash': expected_hash})
    MEDIA_VOLUME.commit()
    output_dir = job_dir / 'outputs'
    output_dir.mkdir(exist_ok=True)
    try:
        for item in request.get('inputs', []):
            if not re.fullmatch(r'[a-z0-9-]+\.mp4', item['name']):
                raise ValueError('Invalid remote input name')
            path = job_dir / 'inputs' / item['name']
            if path.stat().st_size != item['size'] or hash_file(path) != item['sha256']:
                raise ValueError('Remote input checksum mismatch')
        with (output_dir / 'operation.stdout.log').open('w') as stdout, (output_dir / 'operation.stderr.log').open('w') as stderr:
            done = run_supervised(['node', '/opt/kavion-media/scripts/media-remote.mjs', str(request_path), str(output_dir)], stdout=stdout, stderr=stderr, timeout=1750, cwd='/opt/kavion-media')
        if done.returncode:
            raise RuntimeError((output_dir / 'operation.stderr.log').read_text()[-2500:] or f'Node exited {done.returncode}')
        result = json.loads((output_dir / 'result.json').read_text())
        files = []
        top_level = {'cut.mp4', 'cuts.json', 'cuts.ffscript', 'final.mp4', 'verification.json', 'smoke-report.json', 'caption.png', 'broll.png', 'return.png', 'operation.stdout.log', 'operation.stderr.log', 'repaired-broll.mp4', 'broll-repair.json'}
        if request['operation'] == 'frames':
            top_level.update(f'sheet-{index}.jpg' for index in range(4))
        for path in output_dir.rglob('*'):
            if not path.is_file() or path.is_symlink():
                continue
            relative = path.relative_to(output_dir).as_posix()
            if relative not in top_level and relative not in {'composition/index.html', 'composition/timeline.json', 'composition/lint.json', 'composition/render.log'} and not relative.startswith('composition/assets/'):
                continue
            files.append({'path': relative, 'size': path.stat().st_size, 'sha256': hash_file(path)})
        if sum(item['size'] for item in files) > MAX_OUTPUT_BYTES:
            raise ValueError('Remote artifacts exceed download budget')
        receipt = {'ok': True, 'runtimeContract':RUNTIME_CONTRACT, 'runtimeFingerprint':runtime_fingerprint(), 'operation': request['operation'], 'requestHash': expected_hash, 'result': result, 'files': files,
                   'resources': {'elapsedSeconds': round(time.monotonic() - started, 3), 'childPeakRssKiB': resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss, 'cpuRequest': 2, 'memoryRequestMiB': 4096, 'memoryLimitMiB': 8192}, 'finishedAt': time.time()}
    except Exception as error:
        receipt = {'ok': False, 'runtimeContract':RUNTIME_CONTRACT, 'runtimeFingerprint':runtime_fingerprint(), 'operation': request['operation'], 'requestHash': expected_hash, 'error': str(error), 'elapsedSeconds': round(time.monotonic() - started, 3)}
    atomic_save(receipt_path, receipt)
    MEDIA_VOLUME.commit()
    return receipt


def main():
    try:
        command = sys.argv[1]
        if command == 'client':
            request_path, state_path, output_dir = map(Path, sys.argv[2:5])
            result = run_client(json.loads(request_path.read_text()), state_path, output_dir)
        elif command == 'check':
            import modal
            app_name, volume_name, environment = sys.argv[2:5]
            options = {'environment_name': environment} if environment else {}
            modal.Function.from_name(app_name, runtime_function_name(), **options).hydrate()
            modal.Volume.from_name(volume_name, **options).hydrate()
            result = {'ok': True, 'app': app_name, 'volume': volume_name, 'runtimeContract': RUNTIME_CONTRACT, 'runtimeFingerprint':runtime_fingerprint(), 'functionName':runtime_function_name()}
        else:
            raise ValueError('Unknown bridge command')
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error), 'needsAttention': getattr(error, 'needs_attention', False), 'code': getattr(error, 'code', None)}, ensure_ascii=False))


if os.environ.get('KAVION_MEDIA_CLIENT_MODE') != '1':
    app = build_app()

if __name__ == '__main__':
    main()
