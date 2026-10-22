"""Optional conservative voice adaptation; the full v1 recipe stays available."""
import hashlib
import json

import torch


def fingerprint(model):
    digest = hashlib.sha256()
    for name, param in model.named_parameters():
        if not param.requires_grad:
            digest.update(name.encode())
            digest.update(param.detach().cpu().contiguous().numpy().tobytes())
    # The vocabulary extension must learn x without moving any original symbol.
    if getattr(model, '_voice_adaptation', False):
        digest.update(model.text_encoder.embed_tokens.weight[:40].detach().cpu().contiguous().numpy().tobytes())
    return digest.hexdigest()


def configure_adaptation(model, mode):
    if mode == 'full':
        return
    if mode == 'pronunciation':
        model.decoder.requires_grad_(False)
        model.posterior_encoder.requires_grad_(False)
        model._pronunciation_adaptation = True
        keep_frozen_eval(model)
        model._frozen_fingerprint = fingerprint(model)
        return
    if mode != 'voice':
        raise ValueError('Unknown adaptation mode')
    model.text_encoder.requires_grad_(False)
    model.duration_predictor.requires_grad_(False)
    embedding = model.text_encoder.embed_tokens.weight
    if embedding.shape[0] != 41:
        raise ValueError('Voice adaptation expects the verified 41-symbol tokenizer')
    embedding.requires_grad_(True)
    def only_new_symbol(gradient):
        result = torch.zeros_like(gradient)
        result[40:] = gradient[40:]
        return result
    embedding.register_hook(only_new_symbol)
    model._voice_adaptation = True
    keep_frozen_eval(model)
    model._frozen_fingerprint = fingerprint(model)


def keep_frozen_eval(model):
    if getattr(model, '_voice_adaptation', False):
        model.text_encoder.eval()
        model.duration_predictor.eval()
    if getattr(model, '_pronunciation_adaptation', False):
        model.decoder.eval()
        model.posterior_encoder.eval()


def generator_parameter_groups(model):
    if getattr(model, '_pronunciation_adaptation', False):
        return [p for p in model.parameters() if p.requires_grad]
    if not getattr(model, '_voice_adaptation', False):
        return model.parameters()  # Preserve legacy resume optimizer topology.
    embedding = model.text_encoder.embed_tokens.weight
    return [{'params': [p for p in model.parameters() if p.requires_grad and p is not embedding]},
            {'params': [embedding], 'weight_decay': 0.0}]


def verify_adaptation(model, path):
    voice = getattr(model, '_voice_adaptation', False)
    pronunciation = getattr(model, '_pronunciation_adaptation', False)
    if not voice and not pronunciation:
        return
    after = fingerprint(model)
    if after != model._frozen_fingerprint:
        raise RuntimeError('Frozen adaptation weights changed')
    report = {'mode': 'voice' if voice else 'pronunciation', 'frozen_sha256': after, 'frozen_weights_unchanged': True,
              'frozen': ['text_encoder (except new x embedding)', 'duration_predictor'] if voice else ['decoder', 'posterior_encoder'],
              'trainable_parameters': sum(p.numel() for p in model.parameters() if p.requires_grad)}
    path.write_text(json.dumps(report, indent=2) + '\n')
