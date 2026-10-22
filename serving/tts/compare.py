"""Private, reproducible listening grid. Acoustic checks are not quality scores."""
import argparse
import hashlib
import io
import json
from pathlib import Path

import numpy as np
import soundfile as sf

from delivery import delivery_plan
from engine import VoiceEngine


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--index', required=True, type=Path)
    p.add_argument('--output', required=True, type=Path)
    p.add_argument('--model', default=Path(__file__).parent / 'model', type=Path)
    args = p.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    engine = VoiceEngine(args.model)
    prompts = [s for s in json.loads(args.index.read_text())['samples'] if s['kind'] == 'held-out'][:10]
    results = []
    choices = [('final', p) for p in ('original', 'steady', 'gentle')]
    choices += [(f'step-{step}', 'original') for step in (2000, 4000, 6000, 8000)]
    for model, profile in choices:
        for sample in prompts:
            text, segments = delivery_plan(sample['text'], engine.vocab, profile)
            result = engine.speak(text, profile, model, segments)
            filename = f"{model}-{profile}-{sample['id']}.wav"
            (args.output / filename).write_bytes(result['wav'])
            audio, rate = sf.read(io.BytesIO(result['wav']))
            assert rate == 16000 and audio.ndim == 1 and np.isfinite(audio).all()
            assert np.max(np.abs(audio)) > 1e-5 and np.max(np.abs(audio)) < 1
            results.append({'id': sample['id'], 'text': sample['text'], 'model': model, 'profile': profile,
                'file': filename, 'sha256': hashlib.sha256(result['wav']).hexdigest(),
                'duration_seconds': result['duration'], 'generation_ms': result['generation_ms'],
                'rms': float(np.sqrt(np.mean(audio ** 2))), 'peak': float(np.max(np.abs(audio))),
                'segments': segments})
        print(f'Compared {model}/{profile}', flush=True)
    (args.output / 'index.json').write_text(json.dumps({'seed': 456, 'sampling_rate': 16000,
        'evaluation_only': True, 'human_quality_judgment': 'pending', 'results': results}, indent=2, ensure_ascii=False) + '\n')


if __name__ == '__main__':
    main()
