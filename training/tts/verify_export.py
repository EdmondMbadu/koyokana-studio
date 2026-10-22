"""Independently check a completed cloud export before packaging inference."""
import argparse
import hashlib
import json
import math
import wave
from pathlib import Path

import numpy as np
import torch
from safetensors import safe_open


def verify(root, metadata, run_id, step, resume_step=None):
    marker = json.loads((root / 'succeeded.json').read_text())
    if not marker['training_complete'] or marker['last_training_step'] != step or marker['target_step'] != step:
        raise ValueError('The expected training run has not completed')
    expected = {'config.json', 'model.safetensors', 'preprocessor_config.json',
                'special_tokens_map.json', 'tokenizer_config.json', 'vocab.json'}
    seen = set()
    for item in metadata:
        value = item['metadata']
        name = Path(value['name']).name
        if value['name'] != f'runs/{run_id}/model/{name}' or name not in expected or name in seen:
            raise ValueError('Unexpected model object')
        if hashlib.sha256((root / 'model' / name).read_bytes()).hexdigest() != value['metadata']['tts_sha256']:
            raise ValueError('Export hash mismatch')
        seen.add(name)
    if seen != expected:
        raise ValueError('Incomplete model package')
    tensors = 0
    torch.set_num_threads(2)
    with safe_open(str(root / 'model/model.safetensors'), framework='pt') as weights:
        for name in weights.keys():
            if not torch.isfinite(weights.get_tensor(name)).all():
                raise ValueError('Nonfinite model tensor')
            tensors += 1
    audit = json.loads((root / 'adaptation-validation.json').read_text())
    if audit['mode'] != 'pronunciation' or not audit['frozen_weights_unchanged']:
        raise ValueError('Frozen decoder/audio encoder check failed')
    source = json.loads((root / 'initial-model-source.json').read_text())
    pinned = json.loads((Path(__file__).parent / 'voice-source.json').read_text())
    if source['run_id'] != pinned['run_id'] or source['dataset_fingerprint'] != pinned['dataset_fingerprint']:
        raise ValueError('Incorrect warm initialization')
    if {k: v['sha256'] for k, v in source['files'].items()} != pinned['files']:
        raise ValueError('Warm initialization hash mismatch')
    metrics = [json.loads(line) for line in (root / 'metrics.jsonl').read_text().splitlines()]
    updates = [r['step'] for r in metrics if 'train_summed_losses' in r]
    if not updates or max(updates) != step:
        raise ValueError('Missing optimization history')
    if resume_step is not None:
        restore = json.loads((root / 'resume-loaded-0.json').read_text())
        if (marker.get('recovered_from_step') != resume_step or restore['restored_step'] != resume_step
                or len(restore['optimizers']) != 2
                or any(o['max_step'] != resume_step or o['foreach'] is not False for o in restore['optimizers'])
                or set(updates) != set(range(resume_step + 1, step + 1))):
            raise ValueError('Optimizer recovery or remaining update history is incomplete')
    for record in metrics:
        if any(not math.isfinite(v) for k, v in record.items() if k.startswith(('train_', 'val_')) and isinstance(v, (int, float))):
            raise ValueError('Nonfinite training/evaluation metric')
    index = json.loads((root / 'samples/index.json').read_text())
    if index['run_id'] != run_id or len(index['samples']) != 43:
        raise ValueError('Unexpected sample index')
    wavs = list((root / 'samples').glob('*.wav'))
    if len(wavs) != 119:
        raise ValueError('Missing sample WAVs')
    for path in wavs:
        with wave.open(str(path)) as stream:
            if (stream.getframerate(), stream.getnchannels(), stream.getsampwidth()) != (16000, 1, 2):
                raise ValueError('Incorrect WAV format')
            data = np.frombuffer(stream.readframes(stream.getnframes()), dtype='<i2').astype(np.int32)
            if len(data) < 800 or np.max(np.abs(data)) < 2:
                raise ValueError('Silent or truncated sample')
    return {'run_id': run_id, 'step': step, 'training_complete': True, 'tensor_count': tensors,
            'wav_count': len(wavs), 'frozen_weights_verified': True, 'warm_source_verified': True,
            'human_quality_evaluation': 'pending'}


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--directory', type=Path, required=True)
    p.add_argument('--metadata', type=Path, required=True)
    p.add_argument('--run-id', required=True)
    p.add_argument('--step', type=int, required=True)
    p.add_argument('--resume-step', type=int)
    args = p.parse_args()
    result = verify(args.directory, json.loads(args.metadata.read_text()), args.run_id, args.step, args.resume_step)
    (args.directory / 'export-validation.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
