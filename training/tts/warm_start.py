"""Load the exact verified first voice, never an arbitrary replacement model."""
import hashlib
import json
from pathlib import Path

from storage_io import file_sha256


def dataset_fingerprint(clips):
    rows = sorted((r['id'], r['raw_sha256'], r['model_text'], r['split']) for r in clips)
    return hashlib.sha256(json.dumps(rows, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def prepare_first_voice(store, work, source=None):
    source = source or json.loads((Path(__file__).parent / 'voice-source.json').read_text())
    prep = json.loads((work / 'preprocessing.json').read_text())
    if prep['manifest_sha256'] != source['manifest_sha256'] or dataset_fingerprint(prep['clips']) != source['dataset_fingerprint']:
        raise ValueError('Pronunciation warm start requires the exact original recordings, transcripts and split')
    target = work / 'initial-model'
    target.mkdir()
    files = {}
    for filename, digest in source['files'].items():
        metadata = store.download(source['uri'] + '/' + filename, target / filename)
        if file_sha256(target / filename) != digest:
            raise ValueError('Initial voice failed its pinned integrity check: ' + filename)
        files[filename] = {'sha256': digest, 'object': metadata}
    report = {'run_id': source['run_id'], 'uri': source['uri'], 'files': files,
              'dataset_fingerprint': source['dataset_fingerprint']}
    (work / 'initial-model-source.json').write_text(json.dumps(report, indent=2) + '\n')
    return str(target)
