"""Bake immutable public checkpoints into the image. Never upload voice data to HF."""
import json
import subprocess
import sys
from pathlib import Path

from huggingface_hub import hf_hub_download, snapshot_download

p = json.loads(Path('/app/provenance.json').read_text())
snapshot_download(p['base_model'], revision=p['base_revision'], local_dir='/opt/models/base',
                  allow_patterns=['*.json', '*.safetensors', 'README.md'])
discriminator = hf_hub_download(p['discriminator_repository'],
    revision=p['discriminator_revision'], filename=p['discriminator_file'])
subprocess.run([sys.executable, '/opt/vits/convert_original_discriminator_checkpoint.py',
    '--checkpoint_path', discriminator, '--generator_checkpoint_path', '/opt/models/base',
    '--pytorch_dump_folder_path', '/opt/models/train'], check=True)
import torch
from utils import VitsModelForPreTraining
# The released Lingala vocabulary omits x, used in the studio's French words
# (taxi, deux, soixante). Add it only to the trainable copy; keep the comparison
# model byte-for-byte original. New embeddings start at the existing mean.
vocab_path = Path('/opt/models/train/vocab.json')
vocab = json.loads(vocab_path.read_text())
vocab['<unk>'] = 39  # Keep IDs contiguous; VitsTokenizer.get_vocab iterates 0..len(vocab)-1.
vocab['x'] = 40  # 0–38 are original symbols; 39 is the tokenizer's added <unk>.
vocab_path.write_text(json.dumps(vocab, ensure_ascii=False))
model = VitsModelForPreTraining.from_pretrained('/opt/models/train')
old_size = model.config.vocab_size
mean = model.get_input_embeddings().weight.detach().mean(dim=0)
torch.manual_seed(456)
model.resize_token_embeddings(41)
with torch.no_grad():
    model.get_input_embeddings().weight[old_size:] = mean
model.save_pretrained('/opt/models/train')
del model
# Both inference and training weights must be loadable without missing parameters.
from transformers import VitsModel, AutoTokenizer
from utils import VitsModelForPreTraining
for cls, path in [(VitsModel, '/opt/models/base'), (VitsModelForPreTraining, '/opt/models/train')]:
    model, info = cls.from_pretrained(path, output_loading_info=True)
    if info['missing_keys'] or info['mismatched_keys']:
        raise RuntimeError(f'Incomplete checkpoint: {info}')
    assert model.config.sampling_rate == 16000
tokenizer = AutoTokenizer.from_pretrained('/opt/models/train')
assert not tokenizer.is_uroman
assert tokenizer('taxi').input_ids != tokenizer('tai').input_ids
assert tokenizer.get_vocab()['x'] == 40
assert 40 in tokenizer('taxi').input_ids


