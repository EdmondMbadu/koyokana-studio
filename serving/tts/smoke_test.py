"""Build gate: real trained model, new text, exact reload, finite PCM audio."""
import hashlib
import io
import json
import statistics
import wave
from pathlib import Path
from unittest.mock import Mock

import numpy as np
from app import create_app
from engine import VoiceEngine

engine = VoiceEngine(Path(__file__).parent / 'model')
client = create_app(engine, Mock()).test_client()
sentences = [
    'Mbote baninga, lelo tozali komeka mongongo na ngai.',
    'Soki oyoki ngai malamu, loba mbote.',
    'Nakobenga yo lisusu nsima ya mosala.',
    'Matondi mingi mpo na lisalisi na yo.',
    'Tokoki kosolola na Lingala awa.',
    'Mbote, nazali Edmond. Nakoki kosalisa yo?',
    'Yaka lobi na ntongo mpo tosala elongo.',
    'Tinda ngai sango soki okomi na ndako.',
    'Nazali na Kinshasa mpe nazali koyoka yo malamu.',
    'Lelo tokoluka nzela ya kosalisa bato na esengo mpe na limemia.',
]
results = []
for text in sentences:
    r = client.post('/api/voice/synthesize', json={'text': text}, headers={'Authorization': 'Bearer test'})
    assert r.status_code == 200, r.json
    assert r.headers['X-Voice-Run'] == '157b3de4f137cb77eeb1-recovery-1'
    assert r.headers['X-Voice-Cached'] == 'false'
    with wave.open(io.BytesIO(r.data)) as f:
        assert (f.getframerate(), f.getnchannels(), f.getsampwidth()) == (16000, 1, 2)
        audio = np.frombuffer(f.readframes(f.getnframes()), dtype='<i2')
        assert len(audio) >= 800 and np.abs(audio.astype(np.int32)).max() > 10
    results.append({'characters': len(text), 'generation_ms': int(r.headers['X-Voice-Generation-Ms']),
                    'duration_seconds': float(r.headers['X-Voice-Duration']), 'wav_sha256': hashlib.sha256(r.data).hexdigest()})
repeat = client.post('/api/voice/synthesize', json={'text': sentences[-1]})
assert repeat.headers['X-Voice-Cached'] == 'true'
assert hashlib.sha256(repeat.data).hexdigest() == results[-1]['wav_sha256']
from delivery import MODEL_IDS
for model_id in MODEL_IDS:
    r = client.post('/api/voice/synthesize', json={'text': sentences[1], 'model': model_id, 'profile': 'steady'})
    assert r.status_code == 200, r.json
    assert r.headers['X-Voice-Model'] == model_id
    assert r.headers['X-Voice-Profile'] == 'steady'
    expected_run = ('tts-v2-kinshasa-r2-recovery-1' if model_id == 'kinshasa-2000' else
                    'tts-v2-kinshasa-r1' if model_id == 'kinshasa-1000' else
                    '157b3de4f137cb77eeb1-recovery-1' if model_id == 'final' else '157b3de4f137cb77eeb1')
    assert r.headers['X-Voice-Source-Run'] == expected_run
    assert float(r.headers['X-Voice-Duration']) > .1
# Verify the user's pronunciation comparison with the same delivery and text.
trials = []
for model_id, step in [('kinshasa-1000', 1000), ('kinshasa-2000', 2000)]:
    r = client.post('/api/voice/synthesize', json={'text': sentences[0], 'model': model_id, 'profile': 'gentle'})
    assert r.status_code == 200, r.json
    assert r.headers['X-Voice-Training-Step'] == str(step)
    assert r.headers['X-Voice-Cached'] == 'false'
    trials.append(r.data)
assert trials[0] != trials[1], 'The new trial returned the previous model audio'
cached_trial = client.post('/api/voice/synthesize', json={'text': sentences[0], 'model': 'kinshasa-1000', 'profile': 'gentle'})
assert cached_trial.headers['X-Voice-Cached'] == 'true'
assert cached_trial.headers['X-Voice-Source-Run'] == 'tts-v2-kinshasa-r1'
assert cached_trial.data == trials[0]
gentle = client.post('/api/voice/synthesize', json={'text': sentences[1], 'profile': 'gentle'})
assert gentle.status_code == 200
# A delivery/model switch must never reuse audio from another selection.
original = client.post('/api/voice/synthesize', json={'text': sentences[1]})
assert hashlib.sha256(original.data).hexdigest() == results[1]['wav_sha256']
assert original.data != gentle.data
assert original.headers['X-Voice-Source-Run'] == '157b3de4f137cb77eeb1-recovery-1'
assert original.headers['X-Voice-Training-Step'] == '9600'
steady_plain = client.post('/api/voice/synthesize', json={'text': 'soki oyoki ngai malamu loba mbote', 'profile': 'steady'})
gentle_plain = client.post('/api/voice/synthesize', json={'text': 'soki oyoki ngai malamu loba mbote', 'profile': 'gentle'})
original_plain = client.post('/api/voice/synthesize', json={'text': 'soki oyoki ngai malamu loba mbote', 'profile': 'original'})
assert steady_plain.status_code == gentle_plain.status_code == original_plain.status_code == 200
# Same one-phrase text isolates the actual runtime noise/rate controls from pauses.
assert len({steady_plain.data, gentle_plain.data, original_plain.data}) == 3
uncached_original = client.post('/api/voice/synthesize', json={'text': 'matondi mpo na lisalisi na yo', 'profile': 'original'})
assert uncached_original.status_code == 200
for name, value in {'speaking_rate': 1.0, 'noise_scale': .667, 'noise_scale_duration': .8}.items():
    assert getattr(engine.model, name) == value
print('REAL MODEL SMOKE PASSED: ' + json.dumps({'run_id': engine.provenance['run_id'], 'new_sentences': len(results),
    'median_generation_ms': statistics.median(r['generation_ms'] for r in results), 'results': results}))
