"""CPU inference for one immutable, verified VITS generator."""
import hashlib
import io
import json
import threading
import time
from collections import OrderedDict
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from transformers import AutoTokenizer, VitsModel
from delivery import MODEL_IDS, PROFILES


class VoiceEngine:
    def __init__(self, folder='/app/model', threads=2):
        root = Path(folder)
        self.root = root
        self.provenance = json.loads((root / 'source.json').read_text())
        self.model_provenance = self.provenance
        for name, digest in self.provenance['files'].items():
            if hashlib.sha256((root / name).read_bytes()).hexdigest() != digest:
                raise RuntimeError('Voice package failed its integrity check')
        torch.set_num_threads(threads)
        torch.set_num_interop_threads(1)
        self.tokenizer = AutoTokenizer.from_pretrained(root, local_files_only=True)
        self.model, info = VitsModel.from_pretrained(root, local_files_only=True, output_loading_info=True)
        if info['missing_keys'] or info['unexpected_keys'] or info['mismatched_keys']:
            raise RuntimeError('Voice model does not load exactly')
        self.model.eval()
        self.model_id = 'final'
        if self.model.config.sampling_rate != 16000:
            raise RuntimeError('Unexpected voice sample rate')
        self.vocab = self.tokenizer.get_vocab()
        self.lock = threading.Lock()
        self.cache = OrderedDict()
        self.cache_bytes = 0

    def speak(self, text, profile='original', model_id='final', segments=None):
        # VITS samples noise. Serialize the fixed RNG seed and inference so two
        # requests cannot change each other's voice, including on local servers.
        with self.lock:
            if profile not in PROFILES or model_id not in MODEL_IDS:
                raise ValueError('Unknown voice or delivery style')
            segments = segments or [(text, 0)]
            key = (model_id, profile, tuple(segments))
            if key in self.cache:
                self.cache.move_to_end(key)
                return {**self.cache[key], 'cached': True, 'generation_ms': 0}
            started = time.perf_counter()
            if model_id != self.model_id:
                folder = self.root if model_id == 'final' else self.root / 'candidates' / model_id
                source = json.loads((folder / 'source.json').read_text())
                for name, digest in source['files'].items():
                    if hashlib.sha256((folder / name).read_bytes()).hexdigest() != digest:
                        raise RuntimeError('Voice candidate failed its integrity check')
                model, info = VitsModel.from_pretrained(folder, local_files_only=True, output_loading_info=True)
                if info['missing_keys'] or info['unexpected_keys'] or info['mismatched_keys']:
                    raise RuntimeError('Voice candidate does not load exactly')
                if model.config.sampling_rate != 16000 or model.config.vocab_size != len(self.vocab):
                    raise RuntimeError('Incompatible voice candidate')
                self.model = model.eval()
                self.model_id = model_id
                self.model_provenance = source
            for name, value in PROFILES[profile].items():
                setattr(self.model.config, name, value)
                # VITS 4.45 copies these values to runtime attributes in __init__.
                # Updating config alone leaves generation at the old defaults.
                setattr(self.model, name, value)
            pieces = []
            for phrase, gap in segments:
                inputs = self.tokenizer(phrase, return_tensors='pt')
                if inputs.input_ids.shape[-1] >= 512:
                    raise ValueError('This passage is too long; use a shorter sentence.')
                torch.manual_seed(456)
                with torch.inference_mode():
                    audio = self.model(**inputs).waveform[0].float().numpy()
                if not 800 <= len(audio) <= 16000 * 60 or not np.isfinite(audio).all():
                    raise RuntimeError('The voice produced invalid audio; try a shorter sentence.')
                if profile != 'original':
                    fade = min(80, len(audio) // 2)
                    audio[:fade] *= np.linspace(0, 1, fade)
                    audio[-fade:] *= np.linspace(1, 0, fade)
                pieces.append(audio)
                if gap:
                    pieces.append(np.zeros(round(gap * 16000), dtype=np.float32))
            audio = np.concatenate(pieces)
            if not 800 <= len(audio) <= 16000 * 60 or not np.isfinite(audio).all():
                raise RuntimeError('The voice produced invalid audio; try a shorter sentence.')
            peak = float(np.abs(audio).max())
            if peak < 1e-5:
                raise RuntimeError('The voice produced silent audio; try a different sentence.')
            audio = audio * min(1.0, 0.98 / peak)
            wav = io.BytesIO()
            sf.write(wav, audio, 16000, format='WAV', subtype='PCM_16')
            result = {'wav': wav.getvalue(), 'duration': len(audio) / 16000,
                      'generation_ms': round(1000 * (time.perf_counter() - started)), 'cached': False,
                      'source_run_id': self.model_provenance['run_id'],
                      'training_step': self.model_provenance['training_step']}
            self.cache[key] = result
            self.cache_bytes += len(result['wav'])
            while len(self.cache) > 64 or self.cache_bytes > 32 * 1024 * 1024:
                _, old = self.cache.popitem(last=False)
                self.cache_bytes -= len(old['wav'])
            return result
