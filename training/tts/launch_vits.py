"""Small adapter around the pinned upstream GAN trainer.

Use a local DatasetDict, persist finite training metrics, and synchronously back
up completed checkpoints. Hyperparameters and GAN loss weights follow the
upstream recipe; patch_vits.py records the checked discriminator-gradient fix.
"""
import json
import math
import os
import subprocess
import sys
import time
from pathlib import Path

from accelerate import Accelerator
from datasets import load_from_disk
from storage_io import Store, file_sha256
from recovery import CHECKPOINT_FILES
from safe_optimizer import SafeAdamW
import run_vits_finetuning as trainer
import torch
from adaptation import keep_frozen_eval, verify_adaptation

torch.optim.AdamW = SafeAdamW

config_path = Path(sys.argv[1])
config = json.loads(config_path.read_text())
data = load_from_disk(config['dataset_name'])


def local_dataset(path, name=None, *, split, **kwargs):
    if path != config['dataset_name'] or split not in ('train', 'eval'):
        raise ValueError('Unexpected dataset or split requested by upstream trainer')
    return data[split]


trainer.load_dataset = local_dataset
# Upstream loads models in eval mode and never switches modes. Ensure dropout is
# active for optimization and disabled for no-grad validation/sample synthesis.
original_forward = trainer.VitsModelForPreTraining.forward


def forward(self, *args, **kwargs):
    self.train(kwargs.get('labels') is not None and torch.is_grad_enabled())
    keep_frozen_eval(self)
    return original_forward(self, *args, **kwargs)


trainer.VitsModelForPreTraining.forward = forward
original_log = Accelerator.log
original_save = Accelerator.save_state
original_load = Accelerator.load_state
metrics_path = Path(config['output_dir']).parent / 'metrics.jsonl'
attempt = int(os.environ.get('TTS_ATTEMPT', '0'))
remote = os.environ.get('TTS_REMOTE_OUTPUT', '').rstrip('/')


def log(self, values, step=None, **kwargs):
    values = {key: float(value) for key, value in values.items()}
    if 'val_loss_mel' in values:
        # The pinned upstream sums one loss per held-out clip. Report means,
        # with explicit counts/version, rather than presenting sums as errors.
        values = {k: v / len(data['eval']) if k.startswith('val_loss_') else v for k, v in values.items()}
    if not all(math.isfinite(v) for v in values.values()):
        raise FloatingPointError(f'Nonfinite loss at step {step}')
    record = {'step': step, 'attempt': attempt, 'time': time.time(), 'metric_version': 2,
              'validation_reduction': 'mean_per_clip', 'validation_clips': len(data['eval']), **values}
    with metrics_path.open('a') as f:
        f.write(json.dumps(record) + '\n')
    if self.is_main_process and remote and (step % 50 == 0 or 'val_loss_mel' in values):
        kind = 'eval' if 'val_loss_mel' in values else 'train'
        path = metrics_path.parent / f'metric-{attempt}-{step}-{kind}.json'
        path.write_text(json.dumps(record) + '\n')
        try:
            Store().upload(path, f'{remote}/metrics/attempt-{attempt}/step-{step:08d}-{kind}.json', allow_identical=True)
        except Exception as error:
            print(f'WARNING: live metric upload failed; local metrics retained: {error}', flush=True)
    return original_log(self, values, step=step, **kwargs)


def save(self, output_dir=None, **kwargs):
    if self.is_main_process:
        verify_adaptation(self.unwrap_model(self._models[0]), metrics_path.parent / 'adaptation-validation.json')
    result = original_save(self, output_dir=output_dir, **kwargs)
    if self.is_main_process:
        path = Path(output_dir)
        hashes = {name: file_sha256(path / name) for name in CHECKPOINT_FILES}
        marker = {'step': int(path.name.split('-')[1]), 'files': hashes}
        target = f'{remote}/checkpoints/attempt-{attempt}/{path.name}'
        if remote:
            Store().upload_tree(path, target, allow_identical=True)
        (path / 'complete.json').write_text(json.dumps(marker, sort_keys=True) + '\n')
        if remote:
            Store().upload(path / 'complete.json', target + '/complete.json', allow_identical=True)
        if os.environ.get('TTS_ADAPTATION', 'full') != 'full':
            # Checkpoints are already durable. A separate CPU process cannot
            # change the live GPU model's mode, RNG or weight normalization.
            subprocess.run([sys.executable, str(Path(__file__).parent / 'checkpoint_preview.py'),
                '--checkpoint', str(path), '--work', str(metrics_path.parent),
                '--step', str(marker['step']), '--remote', remote,
                '--attempt', str(attempt)], check=True)
    return result


def load(self, input_dir=None, **kwargs):
    result = original_load(self, input_dir=input_dir, **kwargs)
    expected = int(Path(input_dir).name.split('-')[1])
    optimizers = []
    for wrapped in self._optimizers:
        optimizer = getattr(wrapped, 'optimizer', wrapped)
        counters = [int(state['step'].item()) for state in optimizer.state.values() if 'step' in state]
        if not counters or max(counters) != expected or any(g.get('foreach') is not False for g in optimizer.param_groups):
            raise RuntimeError('Optimizer state or conservative CUDA settings were not restored')
        optimizers.append({'states': len(counters), 'min_step': min(counters), 'max_step': max(counters), 'foreach': False})
    if len(optimizers) != 2:
        raise RuntimeError('Both generator and discriminator optimizers must be restored')
    report = {'restored_step': expected, 'attempt': attempt, 'optimizers': optimizers}
    path = metrics_path.parent / f'resume-loaded-{attempt}.json'
    path.write_text(json.dumps(report, indent=2) + '\n')
    if remote:
        Store().upload(path, remote + '/' + path.name, allow_identical=True)
    print('VERIFIED CHECKPOINT RESTORE: ' + json.dumps(report), flush=True)
    return result


Accelerator.log = log
Accelerator.save_state = save
Accelerator.load_state = load
trainer.main()

