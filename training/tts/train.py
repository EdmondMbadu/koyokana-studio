"""Koyokana's single-GPU Lingala voice-training entry point."""
import argparse
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

from data import gs_parts, normalize_text, preprocess_audio, read_manifest
from storage_io import Store
from recovery import checkpoint_source, restore_checkpoint, export_checkpoint, CHECKPOINT_FILES
from storage_io import file_sha256

ROOT = Path(__file__).resolve().parent
LOG = logging.getLogger('tts-train')


def write_json(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--manifest', required=True)
    p.add_argument('--base-model', default='UBC-NLP/Simba-TTS-lin',
                   choices=['UBC-NLP/Simba-TTS-lin'])
    p.add_argument('--output', required=True)
    p.add_argument('--run-id', required=True)
    p.add_argument('--epochs', type=int, default=100)
    p.add_argument('--learning-rate', type=float, default=2e-5)
    p.add_argument('--batch-size', type=int, default=8)
    p.add_argument('--max-steps', type=int, default=-1)
    p.add_argument('--save-steps', type=int, default=1000)
    p.add_argument('--resume-from', help='Verified checkpoint URI from a previous run')
    p.add_argument('--export-only', action='store_true', help='Export a saved checkpoint without more optimization')
    p.add_argument('--cuda-retries', type=int, default=1, help='Bounded fresh-process retry after a CUDA illegal access')
    p.add_argument('--sample-device', choices=['cpu', 'cuda'], default='cpu')
    p.add_argument('--seed', type=int, default=456)
    p.add_argument('--prepare-only', action='store_true')
    p.add_argument('--allow-cpu', action='store_true', help='For explicit smoke testing only')
    p.add_argument('--local-audio-root', help='Map gs:// paths into a local fixture directory (CPU tests only)')
    p.add_argument('--work-dir', default='/work')
    return p


def validate_args(args):
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', args.run_id):
        raise ValueError('Invalid run ID')
    if not 1 <= args.epochs <= 500 or not 1 <= args.batch_size <= 32:
        raise ValueError('Epochs must be 1–500 and batch size 1–32')
    if not 0 < args.learning_rate <= 0.001 or args.save_steps < 1:
        raise ValueError('Invalid learning rate or checkpoint interval')
    if args.max_steps != -1 and args.max_steps < 1:
        raise ValueError('max-steps must be -1 or positive')
    if args.cuda_retries not in (0, 1):
        raise ValueError('cuda-retries must be zero or one')
    if args.export_only and (not args.resume_from or args.prepare_only):
        raise ValueError('export-only requires a checkpoint and cannot prepare-only')
    if args.resume_from:
        checkpoint_source(args.resume_from)
        if args.resume_from.startswith('gs://'):
            bucket, prefix = gs_parts(args.resume_from)
            if not prefix.startswith('runs/') or not args.output.startswith('gs://' + bucket + '/'):
                raise ValueError('Resume checkpoint must be in the same private run bucket')
        elif not args.allow_cpu:
            raise ValueError('Local checkpoint recovery requires explicit CPU testing')
    if args.output.startswith('gs://'):
        bucket, prefix = gs_parts(args.output)
        if prefix.rstrip('/') != 'runs/' + args.run_id:
            raise ValueError('Cloud output must be gs://bucket/runs/<run-id>/')
        if args.local_audio_root:
            raise ValueError('Fixture audio cannot be used with cloud outputs')
    elif not args.allow_cpu:
        raise ValueError('Local output is allowed only with --allow-cpu')
    if args.local_audio_root and not args.allow_cpu:
        raise ValueError('Fixture audio requires --allow-cpu')


def prepare(args, store, work):
    from datasets import Audio, Dataset, DatasetDict
    from transformers import AutoTokenizer

    manifest = work / 'input-manifest.jsonl'
    manifest_source = store.download(args.manifest, manifest)
    rows = read_manifest(manifest.read_text())
    tokenizer = AutoTokenizer.from_pretrained('/opt/models/train')
    vocab = tokenizer.get_vocab()
    processed = []
    hashes = {}
    for row in rows:
        # Never let the tokenizer silently drop a letter from a French loanword.
        unsupported = set(row['model_text']) - set(vocab)
        if unsupported:
            raise ValueError(f"Clip {row['id']}: tokenizer lacks {sorted(unsupported)}")
        token_count = len(tokenizer(row['model_text']).input_ids)
        if token_count >= 512:
            raise ValueError(f"Clip {row['id']}: transcript exceeds model token limit")
        source = work / 'raw' / (row['id'] + '.wav')
        uri = row['audio']
        if args.local_audio_root:
            _, object_name = gs_parts(uri)
            uri = str(Path(args.local_audio_root) / object_name)
        metadata = store.download(uri, source)
        raw_hash = hashlib.sha256(source.read_bytes()).hexdigest()
        if raw_hash in hashes and hashes[raw_hash] != row['split']:
            raise ValueError('Identical audio appears in train and eval')
        hashes[raw_hash] = row['split']
        target = work / 'audio' / (row['id'] + '.wav')
        try:
            report = preprocess_audio(source, target)
        except ValueError as error:
            raise ValueError(f"Clip {row['id']}: {error}") from error
        if token_count >= int(report['duration'] * 16000) // 256 - 2:
            raise ValueError(f"Clip {row['id']}: transcript is too long for the audio alignment")
        if row.get('sample_rate') and int(row['sample_rate']) != report['source_sample_rate']:
            raise ValueError(f"Clip {row['id']}: manifest sample rate disagrees with WAV header")
        processed.append({**row, 'local_audio': str(target), 'source_object': metadata,
                          'raw_sha256': raw_hash, 'processing': report})
        LOG.info('Prepared %s (%s, %.2fs)', row['id'], row['split'], report['duration'])
    dataset = DatasetDict({split: Dataset.from_list([
        {'audio': r['local_audio'], 'text': r['model_text']}
        for r in processed if r['split'] == split
    ]).cast_column('audio', Audio(sampling_rate=16000)) for split in ('train', 'eval')})
    dataset.save_to_disk(str(work / 'dataset'))
    write_json(work / 'preprocessing.json', {'manifest': manifest_source,
        'manifest_sha256': hashlib.sha256(manifest.read_bytes()).hexdigest(),
        'counts': {s: len(dataset[s]) for s in dataset}, 'clips': processed})
    return processed


def training_config(args, work):
    return {
        'project_name': 'koyokana-' + args.run_id,
        'model_name_or_path': '/opt/models/train',
        'dataset_name': str(work / 'dataset'), 'train_split_name': 'train', 'eval_split_name': 'eval',
        'audio_column_name': 'audio', 'text_column_name': 'text',
        'output_dir': str(work / 'model'), 'overwrite_output_dir': False,
        'push_to_hub': False, 'report_to': [], 'do_train': True, 'do_eval': True,
        'num_train_epochs': args.epochs, 'max_steps': args.max_steps,
        'per_device_train_batch_size': args.batch_size, 'per_device_eval_batch_size': 1,
        'learning_rate': args.learning_rate, 'adam_beta1': 0.8, 'adam_beta2': 0.99,
        'gradient_accumulation_steps': 1, 'gradient_checkpointing': False,
        'do_step_schedule_per_epoch': True, 'group_by_length': False,
        'save_steps': args.save_steps, 'save_total_limit': 2, 'eval_steps': 500,
        'preprocessing_num_workers': 1, 'dataloader_num_workers': 0,
        'min_duration_in_seconds': 0.5, 'max_duration_in_seconds': 20.1,
        'max_tokens_length': 512, 'full_generation_sample_text': 'mbote nazali koyoka yo malamu',
        'weight_disc': 3, 'weight_fmaps': 1, 'weight_gen': 1,
        'weight_kl': 1.5, 'weight_duration': 1, 'weight_mel': 35,
        'fp16': False, 'bf16': False, 'seed': args.seed,
        'resume_from_checkpoint': getattr(args, '_resume_checkpoint', None),
        'use_cpu': args.allow_cpu,
    }


def make_samples(args, rows, work):
    import numpy as np
    import soundfile as sf
    import torch
    from transformers import AutoTokenizer, VitsModel, set_seed

    sample_dir = work / 'samples'
    sample_dir.mkdir()
    held_back = sorted((r for r in rows if r['split'] == 'eval'), key=lambda r: r['id'])
    prompts = [{'id': 'eval-' + r['id'], 'text': r['text'], 'model_text': r['model_text'],
                'kind': 'held-out', 'reference_uri': r['audio'], 'clip_id': r['id']} for r in held_back]
    seen = {r['model_text'] for r in rows}
    for i, phrase in enumerate(json.loads((ROOT / 'phone-phrases.json').read_text())):
        text = normalize_text(phrase)
        # A phrase present in any frozen split cannot be advertised as unseen.
        if text not in seen:
            prompts.append({'id': f'phone-{i:02d}', 'text': phrase, 'model_text': text,
                            'kind': 'unseen-phone', 'reference_uri': None, 'clip_id': None})
    device = 'cpu' if args.allow_cpu else args.sample_device
    torch.set_num_threads(4)
    for variant, model_dir in [('baseline', '/opt/models/base'), ('trained', str(work / 'model'))]:
        tokenizer = AutoTokenizer.from_pretrained(model_dir)
        model = VitsModel.from_pretrained(model_dir).to(device).eval()
        for i, prompt in enumerate(prompts):
            set_seed(args.seed + i)
            inputs = tokenizer(prompt['model_text'], return_tensors='pt').to(device)
            prompt[variant + '_unsupported_characters'] = sorted(set(prompt['model_text']) - set(tokenizer.get_vocab()))
            with torch.inference_mode():
                audio = model(**inputs).waveform[0].float().cpu().numpy()
            if not np.isfinite(audio).all() or len(audio) < 800 or np.max(np.abs(audio)) < 1e-5:
                raise ValueError(f"Invalid generated audio: {prompt['id']} / {variant}")
            peak = float(np.max(np.abs(audio)))
            # Preserve relative level; only attenuate if necessary to avoid clipping.
            audio = audio * min(1.0, 0.98 / peak)
            filename = f"{prompt['id']}-{variant}.wav"
            sf.write(sample_dir / filename, audio, 16000, subtype='PCM_16')
            prompt[variant + '_uri'] = args.output.rstrip('/') + '/samples/' + filename
        del model
        if device == 'cuda':
            torch.cuda.empty_cache()
    # Include identically preprocessed real takes for fair playback comparison.
    for prompt, row in zip(prompts, held_back):
        filename = prompt['id'] + '-reference.wav'
        shutil.copyfile(row['local_audio'], sample_dir / filename)
        prompt['processed_reference_uri'] = args.output.rstrip('/') + '/samples/' + filename
    write_json(sample_dir / 'index.json', {'schema_version': 1, 'run_id': args.run_id,
        'sample_rate': 16000, 'baseline_model': args.base_model,
        'questions': ['Is it easy to understand?', 'Does it sound like someone from Kinshasa?'],
        'score_range': [1, 5], 'samples': prompts})
    return len(prompts)


def run(args):
    validate_args(args)
    import torch
    if not args.allow_cpu and not args.prepare_only and not args.export_only and not torch.cuda.is_available():
        raise RuntimeError('CUDA GPU unavailable; refusing to silently run paid training on CPU')
    work = Path(args.work_dir).resolve()
    work.mkdir(parents=True, exist_ok=True)
    if any(work.iterdir()):
        raise ValueError('Use an empty work directory for each run')
    store = Store()
    provenance = json.loads((ROOT / 'provenance.json').read_text())
    source_hashes = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in (
        'train.py', 'data.py', 'storage_io.py', 'launch_vits.py', 'bootstrap.py', 'patch_vits.py',
        'requirements.txt', 'provenance.json', 'phone-phrases.json', 'recovery.py', 'safe_optimizer.py')}
    write_json(work / 'run.json', {'schema_version': 1, 'arguments': vars(args),
        'provenance': provenance, 'started_at': time.time(),
        'source_sha256': source_hashes, 'python_version': sys.version, 'torch_version': torch.__version__,
        'gpu': torch.cuda.get_device_name(0) if torch.cuda.is_available() else None})
    # Atomic create reserves this run; retrying against the same prefix fails.
    store.upload(work / 'run.json', args.output.rstrip('/') + '/run.json')
    try:
        rows = prepare(args, store, work)
        store.upload(work / 'input-manifest.jsonl', args.output.rstrip('/') + '/input-manifest.jsonl')
        store.upload(work / 'preprocessing.json', args.output.rstrip('/') + '/preprocessing.json')
        if args.prepare_only:
            write_json(work / 'prepared.json', {'status': 'prepared', 'training_started': False})
            store.upload(work / 'prepared.json', args.output.rstrip('/') + '/prepared.json')
            return
        resumed = None
        if args.resume_from:
            resumed = restore_checkpoint(args, store, work, rows)
            args._resume_checkpoint = resumed['local_checkpoint']
            write_json(work / 'resumed.json', resumed)
            store.upload(work / 'resumed.json', args.output.rstrip('/') + '/resumed.json', allow_identical=True)
        config = training_config(args, work)
        write_json(work / 'training-config.json', config)
        store.upload(work / 'training-config.json', args.output.rstrip('/') + '/training-config.json')
        env = dict(os.environ, ACCELERATE_MIXED_PRECISION='no',
                   ACCELERATE_USE_CPU=str(args.allow_cpu).lower(), CUDA_LAUNCH_BLOCKING='1',
                   PYTORCH_CUDA_ALLOC_CONF='max_split_size_mb:128,garbage_collection_threshold:0.8')
        if args.output.startswith('gs://'):
            env['TTS_REMOTE_OUTPUT'] = args.output
        target_step = args.max_steps if args.max_steps > 0 else (
            (sum(r['split'] == 'train' for r in rows) + args.batch_size - 1) // args.batch_size * args.epochs)
        if args.export_only:
            export_checkpoint(args._resume_checkpoint, work / 'model')
            write_json(work / 'export-source.json', {'checkpoint_step': resumed['step'], 'target_step': target_step})
            (work / 'metrics.jsonl').write_text(json.dumps({'step': resumed['step'], 'checkpoint_export': True}) + '\n')
            (work / 'training.log').write_text('Explicit checkpoint export; no optimizer steps were performed.\n')
        else:
            # Each retry gets a fresh CUDA process, its own remote namespace,
            # and only a fully committed checkpoint. Never retry from zero.
            for attempt in range(args.cuda_retries + 1):
                env['TTS_ATTEMPT'] = str(attempt)
                attempt_path = work / f'training-config-attempt-{attempt}.json'
                write_json(attempt_path, config)
                store.upload(attempt_path, args.output.rstrip('/') + '/' + attempt_path.name, allow_identical=True)
                with (work / 'training.log').open('a') as log:
                    process = subprocess.Popen([sys.executable, str(ROOT / 'launch_vits.py'), str(attempt_path)],
                        env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
                    recent = []
                    for line in process.stdout:
                        log.write(line)
                        log.flush()
                        print(line, end='', flush=True)
                        recent = (recent + [line])[-120:]
                    code = process.wait()
                if not code:
                    break
                details = ''.join(recent)
                checkpoints = sorted((p for p in (work / 'model').glob('checkpoint-*')
                    if (p / 'complete.json').exists()), key=lambda p: int(p.name.split('-')[1]))
                if attempt >= args.cuda_retries or 'an illegal memory access' not in details or not checkpoints:
                    raise RuntimeError(f'Training process exited with code {code}. Last diagnostics:\n{details[-12000:]}')
                latest = checkpoints[-1]
                marker = json.loads((latest / 'complete.json').read_text())
                if any(marker['files'][n] != file_sha256(latest / n) for n in CHECKPOINT_FILES):
                    raise RuntimeError('Refusing retry from an incomplete checkpoint')
                config['resume_from_checkpoint'] = str(latest)
                LOG.warning('CUDA process failed; bounded retry from verified step %s', marker['step'])
        metrics = [json.loads(l) for l in (work / 'metrics.jsonl').read_text().splitlines()]
        if not args.export_only and not any(m.get('step', 0) > 0 and 'train_summed_losses' in m for m in metrics):
            raise RuntimeError('Trainer completed without an optimizer step')
        last_step = max(m.get('step') or 0 for m in metrics)
        if not args.export_only and last_step != target_step:
            raise RuntimeError(f'Training stopped at {last_step}; expected exactly {target_step}')
        # Optimizer states are already backed up separately; export inference files.
        for path in sorted((work / 'model').iterdir()):
            if path.is_file():
                store.upload(path, args.output.rstrip('/') + '/model/' + path.name, allow_identical=True)
        # The complete trained model is durable before sample generation starts.
        samples = make_samples(args, rows, work)
        store.upload_tree(work / 'samples', args.output.rstrip('/') + '/samples', allow_identical=True)
        for filename in ('training.log', 'metrics.jsonl'):
            store.upload(work / filename, args.output.rstrip('/') + '/' + filename, allow_identical=True)
        write_json(work / 'succeeded.json', {'status': 'succeeded', 'sample_count': samples,
            'finished_at': time.time(), 'last_training_step': last_step,
            'target_step': target_step, 'training_complete': last_step == target_step,
            'recovered_from_step': resumed['step'] if resumed else None,
            'model_uri': args.output.rstrip('/') + '/model/',
            'samples_uri': args.output.rstrip('/') + '/samples/index.json'})
        store.upload(work / 'succeeded.json', args.output.rstrip('/') + '/succeeded.json', allow_identical=True)
        LOG.info('Training and sample generation succeeded: %s', args.output)
    except BaseException as error:
        write_json(work / 'failed.json', {'status': 'failed', 'error': str(error), 'finished_at': time.time()})
        for source, destination in [('failed.json', 'failed.json'), ('training.log', 'failure-training.log'),
                                    ('metrics.jsonl', 'failure-metrics.jsonl')]:
            if (work / source).exists():
                try:
                    store.upload(work / source, args.output.rstrip('/') + '/' + destination, allow_identical=True)
                except Exception:
                    LOG.exception('Could not persist %s; original failure retained', source)
        raise


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    run(parser().parse_args())
