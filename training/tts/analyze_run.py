"""Normalize historical summed validation losses without claiming perceptual quality."""
import argparse
import hashlib
import json
import math
from pathlib import Path


def audit(paths, clips):
    evaluations = {}
    for path in paths:
        for line in path.read_text().splitlines():
            record = json.loads(line)
            if 'val_loss_mel' not in record:
                continue
            divisor = 1 if record.get('metric_version', 1) >= 2 else clips
            values = {key: record[key] / divisor for key in ('val_loss_mel', 'val_loss_kl', 'val_loss_mel_kl')}
            if not all(math.isfinite(v) for v in values.values()):
                raise ValueError('Nonfinite evaluation')
            evaluations[record['step']] = {'step': record['step'], **values}
    rows = sorted(evaluations.values(), key=lambda r: r['step'])
    if not rows:
        raise ValueError('No held-out evaluations')
    return {'validation_clips': clips, 'reduction': 'mean_per_clip',
            'source_sha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in paths},
            'evaluations': rows, 'lowest_mel_step': min(rows, key=lambda r: r['val_loss_mel'])['step'],
            'lowest_mel_kl_step': min(rows, key=lambda r: r['val_loss_mel_kl'])['step'],
            'conclusion': 'Losses do not establish naturalness or an optimal listening checkpoint; human comparison is required.'}


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--metrics', action='append', type=Path, required=True)
    p.add_argument('--clips', type=int, required=True)
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    if args.clips < 1:
        raise ValueError('Evaluation clip count must be positive')
    args.output.write_text(json.dumps(audit(args.metrics, args.clips), indent=2) + '\n')
