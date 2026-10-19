"""Small adapter around the pinned upstream GAN trainer.

Use a local DatasetDict, persist finite training metrics, and synchronously back
up completed checkpoints. Hyperparameters and GAN loss weights follow the
upstream recipe; patch_vits.py records the checked discriminator-gradient fix.
"""
import json
import math
import os
import sys
from pathlib import Path

from accelerate import Accelerator
from datasets import load_from_disk
from storage_io import Store
import run_vits_finetuning as trainer
import torch

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
    return original_forward(self, *args, **kwargs)


trainer.VitsModelForPreTraining.forward = forward
original_log = Accelerator.log
original_save = Accelerator.save_state
metrics_path = Path(config['output_dir']).parent / 'metrics.jsonl'


def log(self, values, step=None, **kwargs):
    values = {key: float(value) for key, value in values.items()}
    if not all(math.isfinite(v) for v in values.values()):
        raise FloatingPointError(f'Nonfinite loss at step {step}')
    with metrics_path.open('a') as f:
        f.write(json.dumps({'step': step, **values}) + '\n')
    return original_log(self, values, step=step, **kwargs)


def save(self, output_dir=None, **kwargs):
    result = original_save(self, output_dir=output_dir, **kwargs)
    if self.is_main_process and os.environ.get('TTS_REMOTE_OUTPUT'):
        target = os.environ['TTS_REMOTE_OUTPUT'].rstrip('/')
        Store().upload_tree(output_dir, target + '/checkpoints/' + Path(output_dir).name)
    return result


Accelerator.log = log
Accelerator.save_state = save
trainer.main()

