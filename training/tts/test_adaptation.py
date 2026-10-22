import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import torch
from adaptation import configure_adaptation, generator_parameter_groups, keep_frozen_eval, verify_adaptation


class AdaptationTests(unittest.TestCase):
    def model(self):
        model = torch.nn.Module()
        model.text_encoder = torch.nn.Module()
        model.text_encoder.embed_tokens = torch.nn.Embedding(41, 4)
        model.text_encoder.linear = torch.nn.Linear(4, 4)
        model.duration_predictor = torch.nn.Linear(4, 4)
        model.decoder = torch.nn.Linear(4, 4)
        model.posterior_encoder = torch.nn.Linear(4, 4)
        return model

    def test_old_symbols_and_timing_stay_exact_while_new_symbol_and_voice_learn(self):
        model = self.model()
        before = {n: p.detach().clone() for n, p in model.named_parameters()}
        configure_adaptation(model, 'voice')
        optimizer = torch.optim.AdamW(generator_parameter_groups(model), lr=.01)
        for _ in range(3):
            model.train(); keep_frozen_eval(model)
            output = model.decoder(model.text_encoder.embed_tokens(torch.tensor([1, 40]))).sum()
            output.backward(); optimizer.step(); optimizer.zero_grad()
        self.assertFalse(model.text_encoder.training)
        self.assertFalse(model.duration_predictor.training)
        self.assertTrue(torch.equal(before['text_encoder.embed_tokens.weight'][:40], model.text_encoder.embed_tokens.weight[:40]))
        self.assertFalse(torch.equal(before['text_encoder.embed_tokens.weight'][40], model.text_encoder.embed_tokens.weight[40]))
        self.assertFalse(torch.equal(before['decoder.weight'], model.decoder.weight))
        with tempfile.TemporaryDirectory() as temp:
            verify_adaptation(model, Path(temp) / 'audit.json')
            with torch.no_grad():
                model.duration_predictor.weight.add_(.01)
            with self.assertRaises(RuntimeError):
                verify_adaptation(model, Path(temp) / 'audit.json')

    def test_pronunciation_can_learn_while_waveform_renderer_and_audio_encoder_stay_fixed(self):
        model = self.model()
        before = {n: p.detach().clone() for n, p in model.named_parameters()}
        configure_adaptation(model, 'pronunciation')
        optimizer = torch.optim.AdamW(generator_parameter_groups(model), lr=.01)
        loss = model.decoder(model.duration_predictor(model.text_encoder.linear(model.text_encoder.embed_tokens(torch.tensor([1, 40]))))).sum()
        loss.backward(); optimizer.step()
        self.assertTrue(torch.equal(before['decoder.weight'], model.decoder.weight))
        self.assertFalse(torch.equal(before['text_encoder.linear.weight'], model.text_encoder.linear.weight))
        self.assertFalse(torch.equal(before['duration_predictor.weight'], model.duration_predictor.weight))
        with tempfile.TemporaryDirectory() as temp:
            verify_adaptation(model, Path(temp) / 'audit.json')
