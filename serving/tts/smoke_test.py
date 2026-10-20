"""Build gate: real trained model, new text, exact reload, finite PCM audio."""
import hashlib
import io
import json
import statistics
import wave
from unittest.mock import Mock

import numpy as np
from app import create_app
from engine import VoiceEngine

engine = VoiceEngine()
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
print('REAL MODEL SMOKE PASSED: ' + json.dumps({'run_id': engine.provenance['run_id'], 'new_sentences': len(results),
    'median_generation_ms': statistics.median(r['generation_ms'] for r in results), 'results': results}))
