"""Durable CPU listening previews at each conservative training checkpoint."""
import argparse
import json
import tempfile
from pathlib import Path

import soundfile as sf
import torch
from transformers import AutoTokenizer, VitsModel

from recovery import export_checkpoint
from storage_io import Store


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--checkpoint', required=True)
    p.add_argument('--work', required=True, type=Path)
    p.add_argument('--step', required=True, type=int)
    p.add_argument('--remote', default='')
    p.add_argument('--attempt', default='0')
    args = p.parse_args()
    torch.set_num_threads(4)
    prep = json.loads((args.work / 'preprocessing.json').read_text())
    prompts = sorted((r for r in prep['clips'] if r['split'] == 'eval'), key=lambda r: r['id'])[:5]
    target = args.work / 'previews' / f'attempt-{args.attempt}' / f'step-{args.step}'
    target.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryDirectory() as temp:
        export_checkpoint(args.checkpoint, temp)
        model = VitsModel.from_pretrained(temp).eval()
        tokenizer = AutoTokenizer.from_pretrained(temp)
        samples = []
        for row in prompts:
            torch.manual_seed(456)
            with torch.inference_mode():
                audio = model(**tokenizer(row['model_text'], return_tensors='pt')).waveform[0].numpy()
            if not torch.isfinite(torch.from_numpy(audio)).all() or abs(audio).max() < 1e-5:
                raise RuntimeError('Invalid checkpoint preview')
            filename = row['id'] + '.wav'
            sf.write(target / filename, audio, 16000, subtype='PCM_16')
            samples.append({'id': row['id'], 'text': row['text'], 'file': filename})
    (target / 'index.json').write_text(json.dumps({'step': args.step, 'seed': 456,
        'delivery': 'original', 'kind': 'held-out', 'samples': samples}, indent=2) + '\n')
    if args.remote:
        Store().upload_tree(target, args.remote.rstrip('/') + f'/previews/attempt-{args.attempt}/step-{args.step}', allow_identical=True)


if __name__ == '__main__':
    main()
