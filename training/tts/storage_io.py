"""Authenticated GCS IO, with write-once output objects."""
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

    def upload(self, source, uri):
        source = Path(source)
        if uri.startswith('gs://'):
            bucket, name = gs_parts(uri)
            self.client.bucket(bucket).blob(name).upload_from_filename(
                str(source), if_generation_match=0, checksum='crc32c')
        else:
            target = Path(uri)
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as f:
                f.write(source.read_bytes())

    def upload_tree(self, root, uri):
        root = Path(root)
        for path in sorted(root.rglob('*')):
            if path.is_file() and not path.is_symlink():
                self.upload(path, uri.rstrip('/') + '/' + path.relative_to(root).as_posix())

