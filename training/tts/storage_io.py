"""Authenticated GCS IO, with write-once output objects."""
import hashlib
from pathlib import Path
from data import gs_parts


class Store:
    def __init__(self):
        self._client = None

    @property
    def client(self):
        if self._client is None:
            from google.cloud import storage
            self._client = storage.Client()
        return self._client

    def download(self, uri, target):
        target = Path(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        if not uri.startswith('gs://'):
            target.write_bytes(Path(uri).read_bytes())
            return {'source': uri}
        bucket, name = gs_parts(uri)
        blob = self.client.bucket(bucket).blob(name)
        blob.reload()
        generation = int(blob.generation)
        blob.download_to_filename(str(target), if_generation_match=generation, checksum='crc32c')
        return {'source': uri, 'generation': generation, 'crc32c': blob.crc32c}

    def upload(self, source, uri, *, allow_identical=False):
        source = Path(source)
        if uri.startswith('gs://'):
            from google.api_core.exceptions import PreconditionFailed
            bucket, name = gs_parts(uri)
            blob = self.client.bucket(bucket).blob(name)
            digest = file_sha256(source) if allow_identical else None
            if digest:
                blob.metadata = {'tts_sha256': digest}
            try:
                blob.upload_from_filename(str(source), if_generation_match=0, checksum='crc32c')
            except PreconditionFailed:
                # A resumable upload may commit, lose its response, then retry
                # with generation=0. Accept only the same immutable artifact.
                if not allow_identical:
                    raise
                blob.reload()
                if blob.size != source.stat().st_size or (blob.metadata or {}).get('tts_sha256') != digest:
                    raise
        else:
            target = Path(uri)
            target.parent.mkdir(parents=True, exist_ok=True)
            if allow_identical and target.exists() and file_sha256(target) == file_sha256(source):
                return
            with target.open('xb') as f:
                f.write(source.read_bytes())

    def upload_tree(self, root, uri, *, allow_identical=False):
        root = Path(root)
        for path in sorted(root.rglob('*')):
            if path.is_file() and not path.is_symlink():
                self.upload(path, uri.rstrip('/') + '/' + path.relative_to(root).as_posix(),
                            allow_identical=allow_identical)


def file_sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()

