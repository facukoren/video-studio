"""Select the complete transcript, never a partial provider word index."""


def transcript_segments(payload, duration=None):
    if isinstance(payload, list):
        payload = {'words': payload}
    if not isinstance(payload, dict):
        raise ValueError('Invalid transcript')
    segments = payload.get('segments')
    if segments is None or segments == []:
        words = payload.get('words') or payload.get('word_segments')
        segments = [{'start': 0, 'end': duration, 'words': words}]
    if not isinstance(segments, list) or not segments:
        raise ValueError('Missing transcript segments')
    output = []
    for segment in segments:
        if not isinstance(segment, dict):
            raise ValueError('Invalid segment')
        words = segment.get('words')
        text = segment.get('text')
        if isinstance(text, str) and text.strip():
            tokens = text.split()
            indexed = [w.get('text', w.get('word')) if isinstance(w, dict) else None for w in words] if isinstance(words, list) else None
            # Segment text is the complete ASR transcript. A missing or partial
            # word index cannot erase it; acoustic recovery supplies its times.
            if indexed != tokens:
                words = [{'word': token} for token in tokens]
        if not isinstance(words, list) or not words:
            raise ValueError('Empty segment')
        output.append({**segment, 'words': words})
    return output
