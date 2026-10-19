"""Two real GAN optimizer steps, final eval, model reload and audio generation.

Synthetic tones test mechanics only; they are never a voice-quality claim.
"""
import json
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from safetensors import safe_open
from train import parser, run

torch.set_num_threads(4)
with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    records = []
    for i, (split, text) in enumerate([('train', 'Mbote taxi.'), ('eval', 'Matondi mingi.')]):
        path = root / 'fixtures' / 'recordings' / f'clip{i}.wav'
        path.parent.mkdir(parents=True, exist_ok=True)
        time = np.arange(48000 * 2) / 48000
        sf.write(path, (0.05 * np.sin(2 * np.pi * (200 + 50 * i) * time)).astype('float32'),
                 48000, subtype='PCM_24')
        records.append({'id': f'clip{i}', 'text': text, 'speaker': 'synthetic', 'split': split,
                        'audio': f'gs://fixture/recordings/clip{i}.wav', 'sample_rate': 48000})
    manifest = root / 'manifest.jsonl'
    manifest.write_text('\n'.join(json.dumps(r) for r in records))
    args = parser().parse_args([
        '--manifest=' + str(manifest), '--output=' + str(root / 'result'),
        '--work-dir=' + str(root / 'work'), '--local-audio-root=' + str(root / 'fixtures'),
        '--run-id=smoke', '--epochs=2', '--batch-size=1', '--max-steps=2',
        '--save-steps=1', '--allow-cpu'])
    run(args)
    result = json.loads((root / 'result' / 'succeeded.json').read_text())
    assert result['last_training_step'] == 2, result
    metrics = [json.loads(line) for line in (root / 'result' / 'metrics.jsonl').read_text().splitlines()]
    assert any('val_loss_mel' in value for value in metrics), 'Held-out validation never ran'
    assert any((root / 'work' / 'model' / 'checkpoint-2').iterdir()), 'Optimizer checkpoint missing'
    index = json.loads((root / 'result' / 'samples' / 'index.json').read_text())
    assert len(index['samples']) == 11
    assert len(list((root / 'result' / 'samples').glob('*.wav'))) == 23
    key = 'text_encoder.embed_tokens.weight'
    with safe_open('/opt/models/base/model.safetensors', framework='pt') as original:
        with safe_open(str(root / 'result' / 'model' / 'model.safetensors'), framework='pt') as trained:
            before = original.get_tensor(key)
            after = trained.get_tensor(key)
            assert not torch.equal(before, after[:len(before)]), 'Generator never updated'
            assert after.shape[0] == 41, 'Extended vocabulary was not saved'
    print('SMOKE TEST PASSED: two optimizer steps changed generator weights, eval ran, model reloaded, 23 WAVs exported.')

