"""Verified private-checkpoint recovery; never silently starts from zero."""
import json
import re
from pathlib import Path

from data import gs_parts
from storage_io import file_sha256

CHECKPOINT_FILES = ('model.safetensors', 'model_1.safetensors', 'optimizer.bin',
                    'optimizer_1.bin', 'scheduler.bin', 'scheduler_1.bin', 'random_states_0.pkl')


def checkpoint_source(source):
    if source.startswith('gs://'):
        gs_parts(source)
    match = re.fullmatch(r'(.+)/checkpoints/(?:attempt-[0-9]+/)?(checkpoint-([1-9][0-9]*))/?', source)
    if not match:
        raise ValueError('Resume source must end with /checkpoints/checkpoint-<step>')
    return match.group(1), match.group(2), int(match.group(3))


def restore_checkpoint(args, store, work, rows):
    parent, name, step = checkpoint_source(args.resume_from)
    source_dir = work / 'resume-source'
    source_dir.mkdir()
    for filename in ('run.json', 'training-config.json', 'preprocessing.json'):
        store.download(parent + '/' + filename, source_dir / filename)
    run = json.loads((source_dir / 'run.json').read_text())
    original_config = json.loads((source_dir / 'training-config.json').read_text())
    original_prep = json.loads((source_dir / 'preprocessing.json').read_text())
    current_prep = json.loads((work / 'preprocessing.json').read_text())
    for field in ('manifest_sha256', 'counts'):
        if original_prep[field] != current_prep[field]:
            raise ValueError('Resume frozen dataset differs: ' + field)
    before = {r['id']: (r['raw_sha256'], r['model_text'], r['split']) for r in original_prep['clips']}
    after = {r['id']: (r['raw_sha256'], r['model_text'], r['split']) for r in rows}
    if before != after:
        raise ValueError('Resume recordings, transcripts or splits differ')
    for key in ('base_model', 'batch_size', 'learning_rate', 'seed', 'epochs'):
        if run['arguments'][key] != getattr(args, key):
            raise ValueError('Resume training setting differs: ' + key)
    if run['arguments'].get('adaptation', 'full') != getattr(args, 'adaptation', 'full'):
        raise ValueError('Resume adaptation mode differs')
    if run['arguments'].get('initial_model', 'base') != getattr(args, 'initial_model', 'base'):
        raise ValueError('Resume initial voice differs')
    if run['source_sha256']['data.py'] != file_sha256(Path(__file__).parent / 'data.py'):
        raise ValueError('Resume preprocessing implementation differs')
    provenance = json.loads((Path(__file__).parent / 'provenance.json').read_text())
    for key in ('base_model', 'base_revision', 'trainer_revision', 'discriminator_revision', 'vocabulary_extension'):
        if run['provenance'][key] != provenance[key]:
            raise ValueError('Resume model provenance differs: ' + key)
    target = (current_prep['counts']['train'] + args.batch_size - 1) // args.batch_size * args.epochs
    if args.max_steps > 0:
        target = args.max_steps
    if step >= target and not args.export_only:
        raise ValueError('Checkpoint already reached the target; use --export-only')
    target_dir = work / 'model' / name
    target_dir.mkdir(parents=True)
    files = {}
    for filename in CHECKPOINT_FILES:
        metadata = store.download(args.resume_from.rstrip('/') + '/' + filename, target_dir / filename)
        files[filename] = {'sha256': file_sha256(target_dir / filename),
                           'bytes': (target_dir / filename).stat().st_size, 'source': metadata}
    # New checkpoints have a commit marker. Legacy v1.0.1 checkpoints are
    # accepted only after all seven required files and source data are verified.
    try:
        store.download(args.resume_from.rstrip('/') + '/complete.json', source_dir / 'complete.json')
    except (FileNotFoundError,):
        pass
    except Exception as error:
        from google.api_core.exceptions import NotFound
        if not isinstance(error, NotFound):
            raise
    if (source_dir / 'complete.json').exists():
        marker = json.loads((source_dir / 'complete.json').read_text())
        if marker['step'] != step or any(marker['files'].get(n) != files[n]['sha256'] for n in CHECKPOINT_FILES):
            raise ValueError('Checkpoint commit marker does not match downloaded files')
    (target_dir / 'complete.json').write_text(json.dumps({'step': step,
        'files': {n: files[n]['sha256'] for n in CHECKPOINT_FILES}}, sort_keys=True) + '\n')
    return {'checkpoint': args.resume_from, 'step': step, 'target_step': target,
            'files': files, 'local_checkpoint': str(target_dir),
            'sampler_note': 'Legacy checkpoints preserve RNG/optimizer states but not the mid-epoch sampler permutation.'}


def export_checkpoint(checkpoint, target):
    from safetensors.torch import load_file
    from transformers import AutoTokenizer
    from utils import VitsModelForPreTraining
    import torch

    model = VitsModelForPreTraining.from_pretrained('/opt/models/train')
    del model.discriminator
    model.decoder.apply_weight_norm()
    for flow in model.flow.flows:
        torch.nn.utils.weight_norm(flow.conv_pre)
        torch.nn.utils.weight_norm(flow.conv_post)
    state = load_file(str(Path(checkpoint) / 'model.safetensors'))
    missing, unexpected = model.load_state_dict(state, strict=False)
    if missing or unexpected:
        raise ValueError(f'Checkpoint cannot be exported faithfully: missing={missing}, unexpected={unexpected}')
    if any(not torch.isfinite(v).all() for v in model.state_dict().values()):
        raise FloatingPointError('Checkpoint has nonfinite model weights')
    model.decoder.remove_weight_norm()
    for flow in model.flow.flows:
        torch.nn.utils.remove_weight_norm(flow.conv_pre)
        torch.nn.utils.remove_weight_norm(flow.conv_post)
    model.save_pretrained(target)
    AutoTokenizer.from_pretrained('/opt/models/train').save_pretrained(target)
