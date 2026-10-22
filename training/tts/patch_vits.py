"""Checked compatibility/correctness patches to the immutable upstream recipe."""
from pathlib import Path

path = Path('/opt/vits/run_vits_finetuning.py')
source = path.read_text()
source = 'from adaptation import configure_adaptation, generator_parameter_groups\nimport os\n' + source
needle = '    gen_optimizer = torch.optim.AdamW(\n        model.parameters(),'
if source.count(needle) != 1:
    raise RuntimeError('Pinned adaptation optimizer patch no longer applies')
source = source.replace(needle, '    configure_adaptation(model, os.environ.get("TTS_ADAPTATION", "full"))\n'
                        '    gen_optimizer = torch.optim.AdamW(\n        generator_parameter_groups(model),')
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
# The upstream resume restores the optimizer but replays a full partial epoch
# and advances its per-epoch scheduler twice. Preserve the counters and skip
# the already-consumed batch positions (legacy sampler permutations are absent).
needle = '    first_epoch = 0\n'
if source.count(needle) != 1:
    raise RuntimeError('Pinned resume initialization patch no longer applies')
source = source.replace(needle, needle + '    resume_step = 0\n')
needle = '            first_epoch = global_step // num_update_steps_per_epoch\n'
if source.count(needle) != 1:
    raise RuntimeError('Pinned resume offset patch no longer applies')
source = source.replace(needle, needle + '            resume_step = global_step % num_update_steps_per_epoch\n')
needle = '    for epoch in range(first_epoch, training_args.num_train_epochs):\n'
if source.count(needle) != 1:
    raise RuntimeError('Pinned training stop patch no longer applies')
source = source.replace(needle, needle + '        if global_step >= training_args.max_steps:\n            break\n')
needle = '        if training_args.do_step_schedule_per_epoch:\n'
if source.count(needle) != 1:
    raise RuntimeError('Pinned resume scheduler patch no longer applies')
source = source.replace(needle, '        if training_args.do_step_schedule_per_epoch and not (epoch == first_epoch and resume_step):\n')
needle = '        for step, batch in enumerate(train_dataloader):\n'
if source.count(needle) != 1:
    raise RuntimeError('Pinned resume batch patch no longer applies')
source = source.replace(needle, needle + '            if epoch == first_epoch and step < resume_step:\n                continue\n')
path.write_text(source)
print('Applied checked upstream speaker, gradient and resume patches.')
