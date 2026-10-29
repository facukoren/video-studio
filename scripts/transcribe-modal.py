"""Durable client for the existing WhisperX deployment; never deploys a model.

check SETTINGS_JSON performs authenticated metadata lookups only.
transcribe REQUEST_JSON holds a process lock through submission and polling.
"""
from __future__ import annotations
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import time
from transcript_payload import transcript_segments

VERSION = 1
MAX_JSON = 16 * 1024**2
MAX_SOURCE = 2 * 1024**3


class BridgeError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')


def private_directory(path):
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        raise BridgeError('CORRUPT_STATE')
    os.chmod(path, 0o700)
    return path.resolve()


def read_bytes(path, optional=False):
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        if optional:
            return None
        raise
    except OSError:
        raise BridgeError('CORRUPT_STATE') from None
    with os.fdopen(descriptor, 'rb') as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_JSON:
            raise BridgeError('CORRUPT_STATE')
        return handle.read(MAX_JSON + 1)


def read_json(path, optional=False):
    data = read_bytes(path, optional)
    if data is None:
        return None
    try:
        return json.loads(data)
    except (ValueError, TypeError):
        raise BridgeError('CORRUPT_STATE') from None


def atomic_save(path, value):
    path = Path(path)
    data = canonical(value)
    if len(data) > MAX_JSON:
        raise BridgeError('INVALID_RESULT')
    descriptor, name = tempfile.mkstemp(prefix=f'.{path.name}.', dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)
    return data


def hash_source(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_SOURCE:
            raise BridgeError('INVALID_REQUEST')
        digest = hashlib.sha256()
        for block in iter(lambda: handle.read(1024**2), b''):
            digest.update(block)
    return digest.hexdigest(), info.st_size


def validate_settings(settings):
    keys = {'app', 'function', 'filesystem', 'model', 'language', 'diarization', 'environment'}
    if not isinstance(settings, dict) or set(settings) not in (keys, keys | {'gpu'}):
        raise BridgeError('INVALID_REQUEST')
    for key in ('app', 'function', 'filesystem', 'model'):
        if not isinstance(settings[key], str) or not 1 <= len(settings[key]) <= 200:
            raise BridgeError('INVALID_REQUEST')
    if settings['language'] != 'es' or settings['diarization'] is not False or not isinstance(settings['environment'], str) or len(settings['environment']) > 200:
        raise BridgeError('INVALID_REQUEST')
    # Keep legacy settings byte-for-byte compatible with their existing identity.
    # A10 is an explicit choice for this deployment, never an automatic fallback.
    if 'gpu' in settings and (settings['gpu'] != 'A10' or settings['app'] != 'kavion-whisperx-real' or settings['function'] != 'transcribe_file'):
        raise BridgeError('INVALID_REQUEST')
    return settings


def lookup(settings, sdk):
    options = {'environment_name': settings['environment']} if settings['environment'] else {}
    function = sdk.Function.from_name(settings['app'], settings['function'], **options)
    if 'gpu' in settings:
        function = function.with_options(gpu=settings['gpu'])
    function.hydrate()
    filesystem = sdk.NetworkFileSystem.from_name(settings['filesystem'], **options)
    filesystem.hydrate()
    return function, filesystem


def finite_number(value):
    return type(value) in (int, float) and math.isfinite(value)


def bounded_numerals(raw, repairs, offset):
    """Retain isolated numeric tokens WhisperX could not align.

    Only use a <=500ms gap inside one segment, anchored by two original
    timed words. This is an estimate, recorded separately from ASR timing.
    The gap contains spoken numerals, so the 300ms silence-cut limit does
    not apply. Longer gaps remain ambiguous and require review.
    Never discard text, bridge segments, or guess unbounded missing speech.
    """
    if not isinstance(raw, list):
        raise BridgeError('INVALID_RESULT')
    output = list(raw)
    for index in range(1, len(raw) - 1):
        word, previous, following = raw[index], raw[index - 1], raw[index + 1]
        if not all(isinstance(item, dict) for item in (word, previous, following)):
            continue
        text = word.get('text', word.get('word'))
        if not isinstance(text, str) or not re.fullmatch(r'[0-9]+[.,]?', text.strip()) or word.get('start') is not None or word.get('end') is not None:
            continue
        start, end = previous.get('end'), following.get('start')
        if not all(finite_number(item.get(key)) for item in (previous, following) for key in ('start', 'end')):
            continue
        if not 0 < end - start <= .5 + 1e-8:
            continue
        output[index] = {**word, 'start': start, 'end': end}
        repairs.append({'wordIndex': offset + index, 'text': text.strip(), 'start': start, 'end': end, 'method': 'bounded-numeral-gap'})
    return output


def normalize(payload, max_duration, repairs=None):
    repairs = repairs if repairs is not None else []
    if isinstance(payload, str):
        if len(payload.encode()) > MAX_JSON:
            raise BridgeError('INVALID_RESULT')
        try:
            payload = json.loads(payload)
        except ValueError:
            raise BridgeError('INVALID_RESULT') from None
    duration = max_duration
    if isinstance(payload, list):
        raw = payload
    elif isinstance(payload, dict):
        raw = payload.get('words') or payload.get('word_segments')
        if not raw:
            segments = payload.get('segments', [])
            if not isinstance(segments, list) or not all(isinstance(segment, dict) for segment in segments):
                raise BridgeError('INVALID_RESULT')
            raw = []
            for segment in segments:
                raw.extend(bounded_numerals(segment.get('words', []), repairs, len(raw)))
        if 'duration' in payload:
            if not finite_number(payload['duration']) or not 0 < payload['duration'] <= max_duration + .04:
                raise BridgeError('INVALID_RESULT')
            duration = payload['duration']
    else:
        raise BridgeError('INVALID_RESULT')
    if not isinstance(raw, list) or not 1 <= len(raw) <= 10000:
        raise BridgeError('INVALID_RESULT')
    words, previous_end = [], 0
    for word in raw:
        if not isinstance(word, dict):
            raise BridgeError('INVALID_RESULT')
        text = word.get('text', word.get('word'))
        start, end = word.get('start'), word.get('end')
        if not isinstance(text, str) or not text.strip() or len(text) > 2000 or not finite_number(start) or not finite_number(end) or start < previous_end - 1e-8 or end <= start or end > duration + .04:
            raise BridgeError('INVALID_RESULT')
        words.append({'text': text.strip(), 'start': start, 'end': end})
        previous_end = end
    return words



def literal_tokens(payload):
    try:
        raw = [word for segment in transcript_segments(payload) for word in segment['words']]
    except ValueError:
        raise BridgeError('INVALID_RESULT') from None
    if not isinstance(raw, list) or not 1 <= len(raw) <= 10000:
        raise BridgeError('INVALID_RESULT')
    tokens = []
    for word in raw:
        text = word.get('text', word.get('word')) if isinstance(word, dict) else None
        if not isinstance(text, str) or not text.strip() or len(text) > 2000:
            raise BridgeError('INVALID_RESULT')
        tokens.append(text.strip())
    return tokens


def recover_alignment(request, state, state_path, payload, sdk):
    tokens = literal_tokens(payload)  # Reject malformed transcript shapes before spending.
    service = request.get('recovery')
    if service != {'app': 'kavion-word-alignment', 'function': 'align_words_v1', 'contract': 'kavion-word-alignment-v1'}:
        raise BridgeError('INVALID_REQUEST')
    raw_hash = hashlib.sha256(canonical(payload)).hexdigest()
    identity = hashlib.sha256(canonical({'service': service, 'sourceHash': request['sourceHash'], 'rawHash': raw_hash})).hexdigest()
    alignment = state.get('alignment')
    if alignment is not None:
        if not isinstance(alignment, dict) or alignment.get('fingerprint') != identity or alignment.get('phase') not in ('pending', 'submitted', 'complete'):
            raise BridgeError('CORRUPT_STATE')
        if alignment.get('phase') == 'pending' and not alignment.get('call_id'):
            raise BridgeError('ALIGNMENT_UNCERTAIN')
        if not isinstance(alignment.get('call_id'), str) or not re.fullmatch(r'fc-[A-Za-z0-9_-]{1,200}', alignment['call_id']):
            raise BridgeError('CORRUPT_STATE')
    else:
        options = {'environment_name': request['settings']['environment']} if request['settings']['environment'] else {}
        remote = f"uploads/video-studio-{request['fingerprint']}/source.mp4"
        try:
            if hash_source(request['source']) != (request['sourceHash'], request['sourceSize']):
                raise BridgeError('INVALID_REQUEST')
            function = sdk.Function.from_name(service['app'], service['function'], **options)
            function.hydrate()
            filesystem = sdk.NetworkFileSystem.from_name(request['settings']['filesystem'], **options)
            filesystem.hydrate()
            filesystem.add_local_file(request['source'], remote)
            if hash_source(request['source']) != (request['sourceHash'], request['sourceSize']):
                raise BridgeError('INVALID_REQUEST')
        except BridgeError:
            raise
        except Exception:
            raise BridgeError('NOT_READY') from None
        alignment = {'fingerprint': identity, 'phase': 'pending', 'submittedAt': time.time(), 'rawHash': raw_hash}
        state['alignment'] = alignment
        atomic_save(state_path, state)
        try:
            call = function.spawn(remote, request['sourceHash'], raw_hash, payload)
            call_id = call.object_id
            if not isinstance(call_id, str) or not re.fullmatch(r'fc-[A-Za-z0-9_-]{1,200}', call_id):
                raise ValueError('Invalid alignment call ID')
        except Exception:
            raise BridgeError('ALIGNMENT_UNCERTAIN') from None
        alignment.update(phase='submitted', call_id=call_id)
        atomic_save(state_path, state)
    result_path = Path(request['stateDir']) / 'alignment-result.json'
    result = None
    if alignment.get('phase') == 'complete':
        data = read_bytes(result_path, optional=True)
        if data is not None:
            if hashlib.sha256(data).hexdigest() != alignment.get('resultHash'):
                raise BridgeError('CORRUPT_STATE')
            result = json.loads(data)
    if result is None:
        try:
            call = sdk.FunctionCall.from_id(alignment['call_id'])
            deadline = time.monotonic() + request['timeoutSeconds']
            while time.monotonic() < deadline:
                try:
                    result = call.get(timeout=min(20, max(.001, deadline - time.monotonic())))
                    break
                except Exception as error:
                    if type(error).__name__ in ('FunctionTimeoutError', 'OutputExpiredError', 'NotFoundError'):
                        raise BridgeError('ALIGNMENT_FAILED') from None
                    if isinstance(error, (TimeoutError, sdk.exception.TimeoutError)):
                        continue
                    raise BridgeError('ALIGNMENT_FAILED') from None
            else:
                raise BridgeError('RUNNING')
        except BridgeError:
            raise
        except Exception:
            raise BridgeError('ALIGNMENT_FAILED') from None
        data = atomic_save(result_path, result)
        alignment.update(phase='complete', resultHash=hashlib.sha256(data).hexdigest(), completedAt=time.time())
        atomic_save(state_path, state)
    if not isinstance(result, dict) or result.get('contract') != service['contract'] or result.get('sourceHash') != request['sourceHash'] or result.get('rawHash') != raw_hash:
        raise BridgeError('ALIGNMENT_FAILED')
    try:
        if not finite_number(result.get('duration')) or not 0 < result['duration'] <= request['maxDuration'] + .04:
            raise ValueError('Missing recovery duration')
        evidence = result.get('acousticEvidence')
        if not isinstance(evidence, dict) or evidence.get('policy') != 'ctc-confidence-v1' or not finite_number(evidence.get('meanScore')) or not .35 <= evidence['meanScore'] <= 1 or not finite_number(evidence.get('supportedRatio')) or not .75 <= evidence['supportedRatio'] <= 1 or type(evidence.get('wordCount')) is not int or not len(tokens) <= evidence['wordCount'] <= 50000:
            raise ValueError('Insufficient acoustic evidence')
        words = normalize(result, request['maxDuration'])
        if [word['text'] for word in words] != tokens:
            raise ValueError('Recovered transcript changed')
    except Exception:
        raise BridgeError('ALIGNMENT_FAILED') from None
    return words, {'method': 'acoustic-realignment', 'callId': alignment['call_id'], 'wordCount': len(words), 'rawHash': raw_hash}


def validate_request(request):
    if not isinstance(request, dict) or request.get('version') != VERSION:
        raise BridgeError('INVALID_REQUEST')
    settings = validate_settings(request.get('settings'))
    for key in ('fingerprint', 'sourceHash'):
        if not isinstance(request.get(key), str) or not re.fullmatch(r'[a-f0-9]{64}', request[key]):
            raise BridgeError('INVALID_REQUEST')
    expected = hashlib.sha256(canonical({'version': VERSION, 'sourceHash': request['sourceHash'], 'settings': settings})).hexdigest()
    if request['fingerprint'] != expected:
        raise BridgeError('INVALID_REQUEST')
    if type(request.get('sourceSize')) is not int or not 0 < request['sourceSize'] <= MAX_SOURCE:
        raise BridgeError('INVALID_REQUEST')
    if not finite_number(request.get('maxDuration')) or not 0 < request['maxDuration'] <= 3600:
        raise BridgeError('INVALID_REQUEST')
    if not finite_number(request.get('timeoutSeconds')) or not 0 < request['timeoutSeconds'] <= 1800:
        raise BridgeError('INVALID_REQUEST')
    return settings


def cached_result(state, state_dir, request):
    if state.get('phase') != 'complete':
        return None
    data = read_bytes(state_dir / 'result.json', optional=True)
    if data is None:
        return None  # Retrieve the already submitted call again, never spawn.
    if hashlib.sha256(data).hexdigest() != state.get('resultHash'):
        raise BridgeError('CORRUPT_STATE')
    try:
        result = json.loads(data)
    except ValueError:
        raise BridgeError('CORRUPT_STATE') from None
    if result.get('fingerprint') != request['fingerprint']:
        raise BridgeError('CORRUPT_STATE')
    normalize(result, request['maxDuration'])
    return {'ok': True, 'cached': True}


def transcribe(request):
    settings = validate_request(request)
    state_root = private_directory(request['stateRoot'])
    state_dir = private_directory(request['stateDir'])
    if state_dir.parent != state_root or state_dir.name != request['fingerprint']:
        raise BridgeError('INVALID_REQUEST')
    try:
        descriptor = os.open(state_root / 'operation.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    except OSError:
        raise BridgeError('CORRUPT_STATE') from None
    with os.fdopen(descriptor, 'a') as lock:
        if not stat.S_ISREG(os.fstat(lock.fileno()).st_mode):
            raise BridgeError('CORRUPT_STATE')
        os.fchmod(lock.fileno(), 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise BridgeError('BUSY') from None
        active = read_json(state_root / 'active.json', optional=True)
        if active:
            previous = active.get('fingerprint') if isinstance(active, dict) else None
            if not isinstance(previous, str) or not re.fullmatch(r'[a-f0-9]{64}', previous):
                raise BridgeError('CORRUPT_STATE')
            if previous != request['fingerprint']:
                old_state = read_json(state_root / previous / 'state.json', optional=True)
                if not isinstance(old_state, dict) or old_state.get('phase') != 'complete':
                    raise BridgeError('CHANGED')
        state_path = state_dir / 'state.json'
        state = read_json(state_path, optional=True)
        if state is not None and (not isinstance(state, dict) or state.get('fingerprint') != request['fingerprint']):
            raise BridgeError('CORRUPT_STATE')
        state = state or {}
        if state and state.get('phase') not in ('pending', 'submitted', 'complete'):
            raise BridgeError('CORRUPT_STATE')
        if state.get('phase') == 'pending' and not state.get('call_id'):
            raise BridgeError('UNCERTAIN')
        if state and (not isinstance(state.get('call_id'), str) or not re.fullmatch(r'fc-[A-Za-z0-9_-]{1,200}', state['call_id'])):
            raise BridgeError('CORRUPT_STATE')
        if state:
            result = cached_result(state, state_dir, request)
            if result:
                return result
        import modal
        if not state.get('call_id'):
            try:
                if hash_source(request['source']) != (request['sourceHash'], request['sourceSize']):
                    raise BridgeError('INVALID_REQUEST')
                function, filesystem = lookup(settings, modal)
            except BridgeError:
                raise
            except Exception:
                raise BridgeError('NOT_READY') from None
            remote = f"uploads/video-studio-{request['fingerprint']}/source.mp4"
            try:
                filesystem.add_local_file(request['source'], remote)
            except Exception:
                raise BridgeError('REMOTE_FAILED') from None
            if hash_source(request['source']) != (request['sourceHash'], request['sourceSize']):
                raise BridgeError('INVALID_REQUEST')
            atomic_save(state_root / 'active.json', {'fingerprint': request['fingerprint']})
            state = {'version': VERSION, 'fingerprint': request['fingerprint'], 'sourceHash': request['sourceHash'], 'settings': settings, 'phase': 'pending', 'remotePath': remote, 'submittedAt': time.time()}
            atomic_save(state_path, state)
            try:
                call = function.spawn(remote, 'source.mp4', language='es', model_name=settings['model'], enable_diarization=False)
                call_id = call.object_id
                if not isinstance(call_id, str) or not re.fullmatch(r'fc-[A-Za-z0-9_-]{1,200}', call_id):
                    raise ValueError('Invalid call ID')
            except Exception:
                raise BridgeError('UNCERTAIN') from None
            state.update(phase='submitted', call_id=call_id)
            atomic_save(state_path, state)
        if not isinstance(state.get('call_id'), str) or not re.fullmatch(r'fc-[A-Za-z0-9_-]{1,200}', state['call_id']):
            raise BridgeError('CORRUPT_STATE')
        payload = None
        if state.get('rawResultHash'):
            raw_bytes = read_bytes(state_dir / 'raw-result.json', optional=True)
            if raw_bytes is not None:
                if hashlib.sha256(raw_bytes).hexdigest() != state['rawResultHash']:
                    raise BridgeError('CORRUPT_STATE')
                saved = json.loads(raw_bytes)
                if not isinstance(saved, dict) or saved.get('fingerprint') != request['fingerprint']:
                    raise BridgeError('CORRUPT_STATE')
                payload = saved.get('payload')
        if payload is None:
            try:
                call = modal.FunctionCall.from_id(state['call_id'])
            except Exception:
                raise BridgeError('REMOTE_FAILED') from None
            deadline = time.monotonic() + request['timeoutSeconds']
            while time.monotonic() < deadline:
                try:
                    payload = call.get(timeout=min(20, max(.001, deadline - time.monotonic())))
                    break
                except Exception as error:
                    if type(error).__name__ in ('FunctionTimeoutError', 'OutputExpiredError', 'NotFoundError'):
                        raise BridgeError('REMOTE_FAILED') from None
                    if isinstance(error, (TimeoutError, modal.exception.TimeoutError)):
                        continue
                    raise BridgeError('REMOTE_FAILED') from None
            else:
                raise BridgeError('RUNNING')
            if isinstance(payload, str):
                try:
                    payload = json.loads(payload)
                except ValueError:
                    raise BridgeError('INVALID_RESULT') from None
            raw_bytes = atomic_save(state_dir / 'raw-result.json', {'fingerprint': request['fingerprint'], 'payload': payload})
            state['rawResultHash'] = hashlib.sha256(raw_bytes).hexdigest()
            atomic_save(state_path, state)
        try:
            repairs = []
            words = normalize(payload, request['maxDuration'], repairs)
            if [word['text'] for word in words] != literal_tokens(payload):
                raise BridgeError('INVALID_RESULT')
        except Exception:
            if not request.get('recovery'):
                raise BridgeError('INVALID_RESULT') from None
            words, recovery = recover_alignment(request, state, state_path, payload, modal)
            repairs = [recovery]
        data = atomic_save(state_dir / 'result.json', {'fingerprint': request['fingerprint'], 'words': words, 'timingRepairs': repairs})
        state.update(phase='complete', resultHash=hashlib.sha256(data).hexdigest(), completedAt=time.time())
        atomic_save(state_path, state)
        return {'ok': True, 'cached': False}


def main():
    try:
        operation = sys.argv[1]
        if operation == 'check':
            settings = validate_settings(json.loads(sys.argv[2]))
            try:
                import modal
                lookup(settings, modal)
            except Exception:
                raise BridgeError('NOT_READY') from None
            result = {'ok': True}
        elif operation == 'transcribe':
            result = transcribe(read_json(Path(sys.argv[2])))
        else:
            raise BridgeError('INVALID_REQUEST')
    except BridgeError as error:
        result = {'ok': False, 'code': error.code}
    except Exception:
        result = {'ok': False, 'code': 'INVALID_REQUEST'}
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
