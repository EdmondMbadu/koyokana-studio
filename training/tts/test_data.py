import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from data import gs_parts, normalize_text, read_manifest
from storage_io import Store
from train import parser, validate_args


def row(id='one', text='Mbote yaya.', split='train', **extra):
    return {'id': id, 'audio': f'gs://private/recordings/speaker/{id}.wav',
            'text': text, 'speaker': 'speaker', 'split': split, **extra}


class ManifestTests(unittest.TestCase):
    def read(self, rows):
        return read_manifest('\n'.join(json.dumps(r) for r in rows))

    def test_existing_studio_manifest_contract(self):
        parsed = self.read([row(sentence_id='s1', duration=3, sample_rate=48000),
                           row('two', 'Matondi mingi.', 'eval', sentence_id='s2')])
        self.assertEqual([r['split'] for r in parsed], ['train', 'eval'])

    def test_french_letters_are_transliterated_not_deleted(self):
        self.assertEqual(normalize_text('Crédit, fête, Béatrice, s’il vous plaît!'),
                         "credit fete beatrice s'il vous plait")

    def test_train_eval_leakage_by_text_and_sentence(self):
        for other in [row('two', 'MBOTE YAYA!', 'eval'),
                      row('two', 'Different text', 'eval', sentence_id='s1')]:
            with self.assertRaisesRegex(ValueError, 'overlap'):
                self.read([row(sentence_id='s1'), other])

    def test_invalid_inputs(self):
        good = [row(), row('two', 'Matondi mingi.', 'eval')]
        for mutation in [dict(id='../evil'), dict(split='test'), dict(audio='https://example.org'),
                         dict(text=''), dict(text='Futa 300 francs.'), dict(speaker='other')]:
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                self.read([good[0], {**good[1], **mutation}])
        with self.assertRaises(ValueError):
            self.read([row()])
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            self.read([row(), row()])

    def test_gcs_paths(self):
        self.assertEqual(gs_parts('gs://bucket/runs/id/'), ('bucket', 'runs/id/'))
        for uri in ['gs://bucket', 'gs://bucket/a/../b', 'gs://bucket/a?token=secret']:
            with self.assertRaises(ValueError):
                gs_parts(uri)

    def test_no_overwrites(self):
        with tempfile.TemporaryDirectory() as temp:
            source, target = Path(temp) / 'source', Path(temp) / 'target'
            source.write_text('a')
            Store().upload(source, str(target))
            with self.assertRaises(FileExistsError):
                Store().upload(source, str(target))
            self.assertEqual(target.read_text(), 'a')

    def test_gcs_upload_uses_sdk_supported_checksum_and_create_precondition(self):
        import base64
        import google_crc32c
        from google.auth.credentials import AnonymousCredentials
        from google.cloud.storage import Client
        content = b'private test artifact'
        response = Mock(status_code=200, headers={})
        response.json.return_value = {'bucket': 'bucket', 'name': 'runs/r1/test.json',
            'generation': '1', 'crc32c': base64.b64encode(google_crc32c.Checksum(content).digest()).decode()}
        transport = Mock()
        transport.request.return_value = response
        client = Client(project='test-project', credentials=AnonymousCredentials(), _http=transport)
        store = Store()
        store._client = client
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / 'test.json'
            source.write_bytes(content)
            # This invokes the real pinned SDK's multipart encoder and checksum
            # validation, while replacing only its HTTP transport. 'auto' fails.
            store.upload(source, 'gs://bucket/runs/r1/test.json')
        self.assertIn('ifGenerationMatch=0', transport.request.call_args.args[1])

    def test_cloud_output_must_match_run(self):
        base = ['--manifest=gs://bucket/datasets/tts-v1/manifest.jsonl', '--run-id=r1']
        validate_args(parser().parse_args(base + ['--output=gs://bucket/runs/r1/']))
        for output in ['gs://bucket/recordings/', 'gs://bucket/runs/r2/']:
            with self.assertRaises(ValueError):
                validate_args(parser().parse_args(base + ['--output=' + output]))


class AudioTests(unittest.TestCase):
    def test_resampling_gain_and_silence(self):
        import numpy as np
        import soundfile as sf
        from data import preprocess_audio
        with tempfile.TemporaryDirectory() as temp:
            source, target = Path(temp) / 'in.wav', Path(temp) / 'out.wav'
            t = np.arange(48000 * 2) / 48000
            wave = np.concatenate([np.zeros(24000), 0.02 * np.sin(2 * np.pi * 220 * t), np.zeros(24000)])
            sf.write(source, wave, 48000, subtype='PCM_24')
            report = preprocess_audio(source, target)
            audio, sr = sf.read(target)
            self.assertEqual(sr, 16000)
            self.assertTrue(2 <= report['duration'] <= 2.4)
            self.assertLessEqual(np.max(np.abs(audio)), 0.9)
            self.assertGreater(report['gain_db'], 0)
            sf.write(source, np.zeros(48000), 48000)
            with self.assertRaisesRegex(ValueError, 'Silent'):
                preprocess_audio(source, target)


if __name__ == '__main__':
    unittest.main()

