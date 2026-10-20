"""Package only inference tensors from the verified private training export."""
import argparse
import hashlib
import json
import shutil
import struct
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('--source', required=True, type=Path)
p.add_argument('--metadata', required=True, type=Path)
p.add_argument('--validation', required=True, type=Path)
p.add_argument('--output', type=Path, default=Path(__file__).parent / 'model')
args = p.parse_args()
validation = json.loads(args.validation.read_text())
if validation['step'] != 9600 or not validation['training_complete']:
    raise ValueError('Use the verified complete first voice export')
for item in json.loads(args.metadata.read_text()):
    metadata = item['metadata']
    source = args.source / Path(metadata['name']).name
    if hashlib.sha256(source.read_bytes()).hexdigest() != metadata['metadata']['tts_sha256']:
        raise ValueError('Source model file differs from its verified cloud export')
args.output.mkdir(parents=True, exist_ok=False)
source = args.source / 'model.safetensors'
with source.open('rb') as f:
    size = struct.unpack('<Q', f.read(8))[0]
    header = json.loads(f.read(size))
    data_start = 8 + size
    output_header = {'__metadata__': {'format': 'pt'}}
    copies = []
    offset = 0
    for name, info in header.items():
        if name == '__metadata__' or name.startswith('discriminator.'):
            continue
        start, end = info['data_offsets']
        output_header[name] = {**info, 'data_offsets': [offset, offset + end - start]}
        copies.append((start, end))
        offset += end - start
    encoded = json.dumps(output_header, separators=(',', ':')).encode()
    encoded += b' ' * (-len(encoded) % 8)
    with (args.output / source.name).open('xb') as out:
        out.write(struct.pack('<Q', len(encoded)))
        out.write(encoded)
        for start, end in copies:
            f.seek(data_start + start)
            out.write(f.read(end - start))
for name in ['config.json', 'vocab.json', 'tokenizer_config.json', 'special_tokens_map.json', 'preprocessor_config.json']:
    shutil.copyfile(args.source / name, args.output / name)
config_path = args.output / 'config.json'
config = json.loads(config_path.read_text())
config['architectures'] = ['VitsModel']
config.pop('_name_or_path', None)
config_path.write_text(json.dumps(config, indent=2) + '\n')
provenance = {'run_id': validation['run_id'], 'training_step': 9600,
              'source_weight_sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
              'inference_tensors': len(copies),
              'files': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(args.output.iterdir())}}
(args.output / 'source.json').write_text(json.dumps(provenance, indent=2) + '\n')
print(json.dumps({k: v for k, v in provenance.items() if k != 'files'}, indent=2))
