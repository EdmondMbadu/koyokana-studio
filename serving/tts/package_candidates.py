"""Convert saved generator checkpoints to exact, offline inference candidates.

No optimizer is loaded and no training or dataset changes are performed.
"""
import argparse
import hashlib
import json
import shutil
from pathlib import Path

import torch
from safetensors.torch import load_file
from transformers import VitsModel


def package(checkpoint, template, target, step):
    if target.exists():
        raise ValueError('Refusing to replace a packaged candidate')
    model = VitsModel.from_pretrained(template, local_files_only=True)
    # Accelerate checkpoints precede the trainer's final weight-norm removal.
    model.decoder.apply_weight_norm()
    for flow in model.flow.flows:
        torch.nn.utils.weight_norm(flow.conv_pre)
        torch.nn.utils.weight_norm(flow.conv_post)
    model.load_state_dict(load_file(str(checkpoint)), strict=True)
    if any(not torch.isfinite(t).all() for t in model.state_dict().values()):
        raise ValueError('Nonfinite checkpoint')
    # Transformers 4.45 applies the newer parametrization API but its removal
    # helper still calls the legacy API. Handle the exact decoder layers here.
    layers = list(model.decoder.upsampler)
    for block in model.decoder.resblocks:
        layers.extend(block.convs1)
        layers.extend(block.convs2)
    for layer in layers:
        if torch.nn.utils.parametrize.is_parametrized(layer, 'weight'):
            torch.nn.utils.parametrize.remove_parametrizations(layer, 'weight', leave_parametrized=True)
        else:
            torch.nn.utils.remove_weight_norm(layer)
    for flow in model.flow.flows:
        torch.nn.utils.remove_weight_norm(flow.conv_pre)
        torch.nn.utils.remove_weight_norm(flow.conv_post)
    target.mkdir(parents=True)
    model.save_pretrained(target)
    for name in ('vocab.json', 'tokenizer_config.json', 'special_tokens_map.json', 'preprocessor_config.json'):
        shutil.copyfile(template / name, target / name)
    source = {'run_id': '157b3de4f137cb77eeb1', 'training_step': step,
              'checkpoint_sha256': hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
              'files': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in target.iterdir()}}
    (target / 'source.json').write_text(json.dumps(source, indent=2) + '\n')
    # Strict reload catches serialization or architecture mistakes immediately.
    _, info = VitsModel.from_pretrained(target, local_files_only=True, output_loading_info=True)
    if info['missing_keys'] or info['unexpected_keys'] or info['mismatched_keys']:
        raise ValueError('Candidate reload failed')
    print(json.dumps({'step': step, 'checkpoint_sha256': source['checkpoint_sha256']}), flush=True)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--checkpoints', required=True, type=Path)
    p.add_argument('--model', default=Path(__file__).parent / 'model', type=Path)
    args = p.parse_args()
    torch.set_num_threads(2)
    for step in (2000, 4000, 6000, 8000):
        package(args.checkpoints / f'{step}.safetensors', args.model, args.model / 'candidates' / f'step-{step}', step)
