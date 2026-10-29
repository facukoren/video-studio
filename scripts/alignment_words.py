"""Map literal ASR tokens to pronounceable Spanish and back; no ASR or timing guesses."""
import json
import math
import re
from numbers import Real
from decimal import Decimal
from num2words import num2words
from transcript_payload import transcript_segments

CONTRACT = 'kavion-word-alignment-v1'


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def spoken_token(text):
    text = text.casefold().replace('−', '-')
    # Spanish thousands groups are removed; a remaining comma/point is decimal.
    def number(match):
        raw = match.group()
        if len(raw) > 24:
            raise ValueError('Numeric token too long')
        if re.fullmatch(r'-?\d{1,3}(?:\.\d{3})+', raw):
            raw = raw.replace('.', '')
        elif ',' in raw and '.' in raw:
            decimal = max(raw.rfind(','), raw.rfind('.'))
            raw = re.sub(r'[.,]', '', raw[:decimal]) + '.' + raw[decimal + 1:]
        else:
            raw = raw.replace(',', '.')
        value = Decimal(raw)
        return ('menos ' if value < 0 else '') + num2words(abs(value), lang='es').replace('punto', 'coma')
    text = re.sub(r'-?\d+(?:[.,]\d+)*', number, text).replace('%', ' por ciento ')
    text = re.sub(r'[^a-záéíóúüñ\s]', ' ', text)
    tokens = text.split()
    if not tokens:
        raise ValueError('Token has no pronounceable text')
    return tokens


def prepare_alignment(payload, duration):
    if not finite(duration) or not 0 < duration <= 600:
        raise ValueError('Invalid source duration')
    if isinstance(payload, str):
        payload = json.loads(payload)
    segments = transcript_segments(payload, duration)
    checked = []
    for segment in segments:
        if not isinstance(segment, dict):
            raise ValueError('Invalid segment')
        a, b = segment.get('start'), segment.get('end')
        if not finite(a) or not finite(b) or not 0 <= a < b <= duration + .04:
            raise ValueError('Invalid segment timing')
        words = segment['words']
        checked.append((a, b, words))
    if any(checked[i][0] < checked[i - 1][1] - 1e-8 for i in range(1, len(checked))):
        raise ValueError('Overlapping transcript segments')
    output, groups, expanded = [], [], []
    for i, (a, b, words) in enumerate(checked):
        # Share the gap between segments without aligning neighbouring speech
        # twice. First/last words can still use the source edges.
        start = (checked[i - 1][1] + a) / 2 if i else 0
        end = (b + checked[i + 1][0]) / 2 if i + 1 < len(checked) else duration
        end = min(end, duration)
        if not 0 <= start < end <= duration or end - start > 90:
            raise ValueError('No bounded acoustic alignment window')
        local = []
        for word in words:
            if not isinstance(word, dict):
                raise ValueError('Invalid transcript word')
            text = word.get('text', word.get('word'))
            if not isinstance(text, str) or not text.strip() or len(text) > 2000:
                raise ValueError('Invalid display token')
            tokens = spoken_token(text.strip())
            groups.append({'text': text.strip(), 'start': len(expanded), 'end': len(expanded) + len(tokens)})
            expanded.extend(tokens)
            local.extend(tokens)
        output.append({'start': start, 'end': end, 'text': ' '.join(local)})
    if len(groups) > 10000 or len(expanded) > 50000:
        raise ValueError('Transcript exceeds alignment limit')
    return {'segments': output, 'groups': groups, 'expanded': expanded}


def native_alignment(aligned):
    """Keep the provider boundary JSON-native, including private diagnostics.

    WhisperX returns NumPy scalar times. No NumPy dependency should be
    required by the client retrieving the Modal result.
    """
    raw = aligned.get('word_segments') if isinstance(aligned, dict) else None
    if not isinstance(raw, list):
        return {'word_segments': None}
    def number(value):
        return float(value) if isinstance(value, Real) and not isinstance(value, bool) and math.isfinite(value) else None
    return {'word_segments': [
        {'word': w.get('word') if isinstance(w.get('word'), str) else None,
         'start': number(w.get('start')), 'end': number(w.get('end')), 'score': number(w.get('score'))}
        if isinstance(w, dict) else None for w in raw]}


def require_acoustic_evidence(aligned):
    """A conservative CTC quality gate, not a guarantee of ASR correctness.

    Short fillers can have zero confidence in otherwise supported speech.
    Reject broadly unsupported text instead of accepting timing geometry alone.
    """
    words = aligned.get('word_segments')
    if not isinstance(words, list) or not words:
        raise ValueError('Missing acoustic evidence')
    scores = [w.get('score') if isinstance(w, dict) else None for w in words]
    if any(not finite(s) or not 0 <= s <= 1 for s in scores):
        raise ValueError('Invalid acoustic confidence')
    mean = sum(scores) / len(scores)
    supported = sum(s >= .1 for s in scores) / len(scores)
    if mean < .35 or supported < .75:
        raise ValueError('Insufficient acoustic evidence')
    return {'policy': 'ctc-confidence-v1', 'meanScore': mean, 'supportedRatio': supported, 'wordCount': len(words)}


def restore_alignment(plan, aligned, duration):
    raw = aligned.get('word_segments') if isinstance(aligned, dict) else None
    if not isinstance(raw, list) or len(raw) != len(plan['expanded']):
        raise ValueError('Acoustic word count changed')
    previous = 0
    for expected, word in zip(plan['expanded'], raw):
        if not isinstance(word, dict) or word.get('word') != expected:
            raise ValueError('Acoustic transcript changed')
        a, b = word.get('start'), word.get('end')
        if not finite(a) or not finite(b) or a < previous - 1e-8 or not 0 <= a < b <= duration + .04:
            raise ValueError('Unaligned or overlapping acoustic word')
        previous = b
    return [{'text': g['text'], 'start': raw[g['start']]['start'], 'end': raw[g['end'] - 1]['end']} for g in plan['groups']]
