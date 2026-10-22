import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from storage_io import Store
from warm_start import dataset_fingerprint, prepare_first_voice


class WarmStartTests(unittest.TestCase):
    def test_pinned_model_and_exact_original_data_are_required(self):
        for changed in (None, 'model', 'audio'):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as temp:
                root = Path(temp); model = root / 'source'; model.mkdir(); work = root / 'work'; work.mkdir()
                (model / 'model.safetensors').write_bytes(b'verified weight fixture')
                clips = [{'id': 'one', 'raw_sha256': 'sha', 'model_text': 'mbote', 'split': 'train'}]
                source = {'run_id': 'fixture', 'uri': str(model), 'manifest_sha256': 'manifest-sha',
                    'dataset_fingerprint': dataset_fingerprint(clips),
                    'files': {'model.safetensors': hashlib.sha256(b'verified weight fixture').hexdigest()}}
                if changed == 'audio':
                    clips[0]['raw_sha256'] = 'changed'
                (work / 'preprocessing.json').write_text(json.dumps({'manifest_sha256': 'manifest-sha', 'clips': clips}))
                if changed == 'model':
                    (model / 'model.safetensors').write_bytes(b'different weights')
                if changed:
                    with self.assertRaises(ValueError):
                        prepare_first_voice(Store(), work, source)
                else:
                    path = prepare_first_voice(Store(), work, source)
                    self.assertEqual((Path(path) / 'model.safetensors').read_bytes(), b'verified weight fixture')
                    self.assertTrue((work / 'initial-model-source.json').exists())
