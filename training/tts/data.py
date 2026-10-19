"""Strict manifest validation and deterministic audio preprocessing."""
import hashlib
import json
import math
import re
import unicodedata
from pathlib import Path
from urllib.parse import urlsplit


def gs_parts(uri):
    p = urlsplit(uri)
    if p.scheme != 'gs' or not p.netloc or not p.path.strip('/') or p.query or p.fragment:
        raise ValueError(f'Expected a gs://bucket/object URI: {uri}')
    if any(part in ('.', '..') for part in p.path.split('/')):
        raise ValueError('Relative path components are forbidden')
    return p.netloc, p.path.lstrip('/')


def normalize_text(text):
    # Simba's vocabulary has no accented French vowels. Transliterate them rather
    # than letting VitsTokenizer silently delete entire letters (crédit -> crdit).
    text = text.lower().translate(str.maketrans({'ɛ': 'e', 'ɔ': 'o', 'œ': 'oe',
        'æ': 'ae', '’': "'", 'ʼ': "'", '–': '-', '—': '-'}))
    text = ''.join(c for c in unicodedata.normalize('NFKD', text)
                   if not unicodedata.combining(c))
    if re.search(r'\d', text):
        raise ValueError('Write numbers as spoken words before freezing the dataset')
    text = re.sub(r'[.,;:!?…"«»]', ' ', text)
    if re.search(r"[^a-z '\-]", text):
        raise ValueError(f'Unsupported characters in transcript: {text}')
    return ' '.join(text.split())


def read_manifest(raw):
    rows = []
    ids, audios, speakers = set(), set(), set()
    groups = {}
    for line_number, line in enumerate(raw.splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
            if not isinstance(row, dict):
                raise ValueError('Each manifest line must be an object')
            for k in ('id', 'audio', 'text', 'speaker', 'split'):
                if not isinstance(row.get(k), str) or not row[k].strip():
                    raise ValueError(f'Missing {k}')
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', row['id']):
                raise ValueError('Unsafe clip ID')
            if row['id'] in ids or row['audio'] in audios:
                raise ValueError('Duplicate clip ID or audio URI')
            gs_parts(row['audio'])
            if row['split'] not in ('train', 'eval'):
                raise ValueError('Split must be train or eval')
            text = normalize_text(row['text'])
            if not text or len(text) > 250:
                raise ValueError('Transcript must contain 1–250 normalized characters')
            # Both sentence IDs and normalized text must stay in one split.
            for key in [f'text:{text}'] + ([f"sentence:{row['sentence_id']}"] if row.get('sentence_id') else []):
                if key in groups and groups[key] != row['split']:
                    raise ValueError('Train/eval sentence overlap; freeze a new dataset with grouped splits')
                groups[key] = row['split']
            ids.add(row['id'])
            audios.add(row['audio'])
            speakers.add(row['speaker'])
            rows.append({**row, 'model_text': text})
        except (ValueError, TypeError) as e:
            raise ValueError(f'Manifest line {line_number}: {e}') from e
    if len(speakers) != 1:
        raise ValueError('The first voice test requires exactly one speaker')
    if not any(r['split'] == 'train' for r in rows) or not any(r['split'] == 'eval' for r in rows):
        raise ValueError('Both nonempty train and eval splits are required')
    return rows


def preprocess_audio(source, target):
    import librosa
    import numpy as np
    import soundfile as sf

    info = sf.info(source)
    if info.format != 'WAV' or info.channels != 1 or info.samplerate < 16000:
        raise ValueError(f'Expected mono WAV at >=16 kHz, got {info}')
    if not 0.6 <= info.duration <= 30:
        raise ValueError(f'Invalid input duration: {info.duration}')
    audio, sr = sf.read(source, dtype='float32')
    if not np.isfinite(audio).all():
        raise ValueError('Nonfinite audio')
    clipped = float(np.mean(np.abs(audio) >= 0.999))
    if clipped > 0.001:
        raise ValueError(f'Clipped recording ({clipped:.2%}); review this take')
    audio = audio - np.mean(audio)
    # Preserve 100 ms around a conservative 40 dB, frame-based silence trim.
    _, (start, end) = librosa.effects.trim(audio, top_db=40, frame_length=1024, hop_length=256)
    pad = int(0.1 * sr)
    audio = audio[max(0, start - pad):min(len(audio), end + pad)]
    audio = librosa.resample(audio, orig_sr=sr, target_sr=16000)
    duration = len(audio) / 16000
    if not 0.6 <= duration <= 20:
        raise ValueError(f'Processed duration {duration:.2f}s is outside 0.6–20s')
    rms = float(np.sqrt(np.mean(audio ** 2)))
    if rms < 1e-4:
        raise ValueError('Silent or effectively silent audio')
    peak = float(np.max(np.abs(audio)))
    gain = min(10 ** (-23 / 20) / rms, 10 ** (-1 / 20) / peak, 10 ** (12 / 20))
    audio *= gain
    Path(target).parent.mkdir(parents=True, exist_ok=True)
    sf.write(target, audio, 16000, subtype='PCM_16')
    return {'source_sample_rate': sr, 'sample_rate': 16000, 'duration': duration,
            'gain_db': 20 * math.log10(gain), 'clipped_fraction': clipped,
            'sha256': hashlib.sha256(Path(target).read_bytes()).hexdigest()}

