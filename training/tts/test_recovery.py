import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from google.api_core.exceptions import PreconditionFailed
from recovery import CHECKPOINT_FILES, checkpoint_source, restore_checkpoint
from storage_io import Store, file_sha256


class RecoveryTests(unittest.TestCase):
    def test_real_storage_sdk_maps_412_and_verifies_the_committed_artifact(self):
        import base64
        import google_crc32c
        from google.auth.credentials import AnonymousCredentials
        from google.cloud.storage import Client
        content = b'checkpoint bytes from a committed upload'
        conflict = Mock(status_code=412, headers={}, text='Precondition failed', content=b'Precondition failed')
        conflict.json.return_value = {'error': {'code': 412, 'message': 'Precondition failed'}}
        metadata = {'bucket': 'bucket', 'name': 'runs/recovery/test.bin', 'generation': '123',
            'size': str(len(content)), 'crc32c': base64.b64encode(google_crc32c.Checksum(content).digest()).decode(),
            'metadata': {'tts_sha256': hashlib.sha256(content).hexdigest()}}
        response = Mock(status_code=200, headers={}, text=json.dumps(metadata))
        response.json.return_value = metadata
        transport = Mock()
        transport.request.side_effect = [conflict, response]
        store = Store()
        store._client = Client(project='test-project', credentials=AnonymousCredentials(), _http=transport)
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'test.bin'
            path.write_bytes(content)
            store.upload(path, 'gs://bucket/runs/recovery/test.bin', allow_identical=True)
        self.assertEqual(transport.request.call_count, 2)

    def test_sources_accept_legacy_and_attempt_checkpoints(self):
        self.assertEqual(checkpoint_source('gs://bucket/runs/old/checkpoints/checkpoint-8000'),
                         ('gs://bucket/runs/old', 'checkpoint-8000', 8000))
        self.assertEqual(checkpoint_source('gs://bucket/runs/new/checkpoints/attempt-1/checkpoint-8200'),
                         ('gs://bucket/runs/new', 'checkpoint-8200', 8200))
        for bad in ['gs://bucket/runs/x', 'gs://bucket/runs/x/checkpoints/checkpoint-0',
                    'gs://bucket/runs/x/../y/checkpoints/checkpoint-1']:
            with self.assertRaises(ValueError):
                checkpoint_source(bad)

    def fixture(self, root):
        source = root / 'original'
        checkpoint = source / 'checkpoints' / 'checkpoint-2'
        checkpoint.mkdir(parents=True)
        work = root / 'work'
        work.mkdir()
        args = SimpleNamespace(resume_from=str(checkpoint), epochs=2, batch_size=1,
            learning_rate=2e-5, seed=456, base_model='UBC-NLP/Simba-TTS-lin', max_steps=4, export_only=False)
        rows = [{'id': 'one', 'raw_sha256': 'audio-sha', 'model_text': 'mbote', 'split': 'train'},
                {'id': 'two', 'raw_sha256': 'other-sha', 'model_text': 'matondi', 'split': 'eval'}]
        prep = {'manifest_sha256': 'frozen-sha', 'counts': {'train': 1, 'eval': 1}, 'clips': rows}
        (work / 'preprocessing.json').write_text(json.dumps(prep))
        (source / 'preprocessing.json').write_text(json.dumps(prep))
        provenance = json.loads((Path(__file__).parent / 'provenance.json').read_text())
        (source / 'run.json').write_text(json.dumps({'arguments': vars(args), 'provenance': provenance,
            'source_sha256': {'data.py': file_sha256(Path(__file__).parent / 'data.py')}}))
        (source / 'training-config.json').write_text('{}')
        for name in CHECKPOINT_FILES:
            (checkpoint / name).write_text('saved-' + name)
        return source, checkpoint, work, args, rows

    def test_complete_legacy_checkpoint_restored_and_hashed(self):
        with tempfile.TemporaryDirectory() as temp:
            _, _, work, args, rows = self.fixture(Path(temp))
            report = restore_checkpoint(args, Store(), work, rows)
            self.assertEqual(report['step'], 2)
            self.assertEqual(report['target_step'], 4)
            self.assertEqual(set(report['files']), set(CHECKPOINT_FILES))
            self.assertTrue((Path(report['local_checkpoint']) / 'complete.json').exists())

    def test_missing_optimizer_never_falls_back_to_fresh_training(self):
        with tempfile.TemporaryDirectory() as temp:
            _, checkpoint, work, args, rows = self.fixture(Path(temp))
            (checkpoint / 'optimizer_1.bin').unlink()
            with self.assertRaises(FileNotFoundError):
                restore_checkpoint(args, Store(), work, rows)

    def test_changed_audio_or_manifest_and_invalid_commit_marker_rejected(self):
        for case in ('audio', 'manifest', 'marker'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temp:
                _, checkpoint, work, args, rows = self.fixture(Path(temp))
                if case == 'audio':
                    rows[0] = {**rows[0], 'raw_sha256': 'changed'}
                elif case == 'manifest':
                    prep = json.loads((work / 'preprocessing.json').read_text())
                    prep['manifest_sha256'] = 'changed'
                    (work / 'preprocessing.json').write_text(json.dumps(prep))
                else:
                    (checkpoint / 'complete.json').write_text(json.dumps({'step': 2, 'files': {}}))
                with self.assertRaises(ValueError):
                    restore_checkpoint(args, Store(), work, rows)

    def test_upload_retry_accepts_identical_artifact_but_never_a_conflict(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / 'artifact'
            source.write_bytes(b'checkpoint data')
            for identical, allowed in ((True, True), (False, True), (True, False)):
                blob = Mock()
                blob.upload_from_filename.side_effect = PreconditionFailed('committed before response was lost')
                def reload():
                    blob.size = source.stat().st_size
                    blob.metadata = {'tts_sha256': file_sha256(source) if identical else 'different'}
                blob.reload.side_effect = reload
                store = Store()
                store._client = Mock()
                store._client.bucket.return_value.blob.return_value = blob
                if identical and allowed:
                    store.upload(source, 'gs://bucket/runs/r/checkpoint', allow_identical=allowed)
                else:
                    with self.assertRaises(PreconditionFailed):
                        store.upload(source, 'gs://bucket/runs/r/checkpoint', allow_identical=allowed)

    def test_local_identical_retry_does_not_overwrite_different_content(self):
        with tempfile.TemporaryDirectory() as temp:
            source, target = Path(temp) / 'source', Path(temp) / 'target'
            source.write_text('first')
            store = Store()
            store.upload(source, str(target), allow_identical=True)
            store.upload(source, str(target), allow_identical=True)
            source.write_text('changed')
            with self.assertRaises(FileExistsError):
                store.upload(source, str(target), allow_identical=True)
            self.assertEqual(target.read_text(), 'first')
