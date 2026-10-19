"""Verify the deployed container's Vertex identity can read and create GCS objects.

Uses synthetic audio only and never starts voice training. Each invocation must
have a fresh run ID. Output lives with the other private run artifacts.
"""
import argparse
import json
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf
from storage_io import Store
from train import parser, run

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--run-id', required=True)
p.add_argument('--bucket', default='koyokana-studio.firebasestorage.app')
options = p.parse_args()
output = f'gs://{options.bucket}/runs/{options.run_id}'
args = parser().parse_args([
    '--run-id=' + options.run_id, '--output=' + output,
    '--manifest=' + output + '/fixtures/manifest.jsonl', '--prepare-only'])
from train import validate_args
validate_args(args)
store = Store()
with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    records = []
    for i, (split, text) in enumerate([('train', 'Mbote taxi.'), ('eval', 'Matondi mingi.')]):
        path = root / f'clip{i}.wav'
        t = np.arange(96000) / 48000
        sf.write(path, 0.05 * np.sin(2 * np.pi * (200 + 50 * i) * t), 48000, subtype='PCM_24')
        uri = output + '/fixtures/' + path.name
        store.upload(path, uri)
        records.append({'id': f'clip{i}', 'speaker': 'synthetic', 'split': split,
                        'text': text, 'audio': uri, 'sample_rate': 48000})
    manifest = root / 'manifest.jsonl'
    manifest.write_text('\n'.join(json.dumps(r) for r in records))
    store.upload(manifest, args.manifest)
run(args)
print('CLOUD SMOKE TEST PASSED: private image launch, attached Vertex identity, GCS read/create and audio preparation.')
