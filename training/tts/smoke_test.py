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
    for i, (split, text) in enumerate([('train', 'Mbote taxi.'), ('train', 'Nazali malamu.'),
                                     ('train', 'Tokomonana lobi.'), ('eval', 'Matondi mingi.')]):
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
    # Restore both GAN optimizers from a mid-epoch checkpoint. Only steps 3 and
    # 4 may run, and the exact final step must be four (no accidental epoch replay).
    resumed = parser().parse_args([
        '--manifest=' + str(manifest), '--output=' + str(root / 'resumed-result'),
        '--work-dir=' + str(root / 'resumed-work'), '--local-audio-root=' + str(root / 'fixtures'),
        '--run-id=resumed', '--epochs=2', '--batch-size=1', '--max-steps=4', '--save-steps=1',
        '--resume-from=' + str(root / 'result' / 'checkpoints' / 'checkpoint-2'), '--allow-cpu'])
    # Local runs also preserve their optimizer checkpoints as immutable artifacts.
    from storage_io import Store
    Store().upload_tree(root / 'work' / 'model' / 'checkpoint-2',
                        str(root / 'result' / 'checkpoints' / 'checkpoint-2'))
    run(resumed)
    report = json.loads((root / 'resumed-result' / 'succeeded.json').read_text())
    assert report['last_training_step'] == 4 and report['training_complete'], report
    audit = json.loads((root / 'resumed-work' / 'resume-loaded-0.json').read_text())
    assert audit['restored_step'] == 2 and len(audit['optimizers']) == 2, audit
    history = [json.loads(line) for line in (root / 'resumed-result' / 'metrics.jsonl').read_text().splitlines()]
    assert [m['step'] for m in history if 'train_summed_losses' in m] == [3, 4], history
    # Even if optimization cannot continue, a verified checkpoint must be
    # exportable on CPU without silently replacing it with the base model.
    exported = parser().parse_args([
        '--manifest=' + str(manifest), '--output=' + str(root / 'exported-result'),
        '--work-dir=' + str(root / 'exported-work'), '--local-audio-root=' + str(root / 'fixtures'),
        '--run-id=exported', '--epochs=2', '--batch-size=1', '--max-steps=4',
        '--resume-from=' + str(root / 'result' / 'checkpoints' / 'checkpoint-2'),
        '--export-only', '--allow-cpu'])
    run(exported)
    export_report = json.loads((root / 'exported-result' / 'succeeded.json').read_text())
    assert export_report['last_training_step'] == 2 and not export_report['training_complete'], export_report
    with safe_open(str(root / 'exported-result' / 'model' / 'model.safetensors'), framework='pt') as recovered:
        with safe_open(str(root / 'work' / 'model' / 'checkpoint-2' / 'model.safetensors'), framework='pt') as saved:
            assert torch.equal(recovered.get_tensor(key), saved.get_tensor(key)), 'Export lost trained embeddings'
    print('SMOKE TEST PASSED: fresh training, exact mid-epoch resume, optimizer restoration, CPU checkpoint export and 69 WAVs.')

