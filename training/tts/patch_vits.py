"""Checked compatibility/correctness patches to the immutable upstream recipe."""
from pathlib import Path

path = Path('/opt/vits/run_vits_finetuning.py')
source = path.read_text()
# Accelerate/BatchEncoding omit None-valued fields during device transfer.
# A mono-speaker model correctly expects None, so do not require the key.
needle = 'speaker_id=batch["speaker_id"],'
if source.count(needle) != 3:
    raise RuntimeError('Pinned optional-speaker-ID patch no longer applies')
source = source.replace(needle, 'speaker_id=batch.get("speaker_id"),')
# Generator backward also populates discriminator gradients. Discard those
# before the next discriminator update, preserving the separate GAN objectives.
needle = '                gen_optimizer.zero_grad()\n'
if source.count(needle) != 1:
    raise RuntimeError('Pinned discriminator-gradient-reset patch no longer applies')
source = source.replace(needle, needle + '                disc_optimizer.zero_grad()\n')
path.write_text(source)
print('Applied checked upstream optional-speaker and discriminator-gradient patches.')
