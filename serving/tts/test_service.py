import io
import unittest
import wave
from types import SimpleNamespace
from unittest.mock import Mock

from access import AccessError
from app import create_app
from text import speech_text


class ServiceTests(unittest.TestCase):
    def setUp(self):
        wav = io.BytesIO()
        with wave.open(wav, 'wb') as f:
            f.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
            f.writeframes(b'\x10\x00' * 16000)
        self.engine = SimpleNamespace(vocab={c: i for i, c in enumerate("abcdefghijklmnopqrstuvwxyz '-")},
            provenance={'run_id': 'test-run'}, speak=Mock(return_value={
                'wav': wav.getvalue(), 'duration': 1.0, 'generation_ms': 12, 'cached': False}))
        self.access = Mock()
        self.access.authorize.return_value = 'studio-admin'
        self.client = create_app(self.engine, self.access).test_client()

    def test_unicode_normalization_matches_training_and_numbers_are_not_guessed(self):
        self.assertEqual(speech_text('Mbóte, mɔtɔ! crédit; taxi.', self.engine.vocab), 'mbote moto credit taxi')
        self.assertEqual(speech_text('Mbote\nna\tyo', self.engine.vocab), 'mbote na yo')
        for text in ['', '---', '!!!', 'mbote 😀', 'loba 12', 'loba ١٢', 'a' * 251]:
            with self.subTest(text=text), self.assertRaises(ValueError):
                speech_text(text, self.engine.vocab)

    def test_returns_new_speech_and_authoritative_text_with_private_headers(self):
        r = self.client.post('/api/voice/synthesize', json={'text': 'Mbóte!'}, headers={'Authorization': 'Bearer user-token'})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.mimetype, 'audio/wav')
        self.assertEqual(r.headers['X-Voice-Text'], 'mbote')
        self.assertEqual(r.headers['Cache-Control'], 'private, no-store')
        self.access.authorize.assert_called_once_with('Bearer user-token')
        self.access.reserve.assert_called_once_with('studio-admin')
        self.engine.speak.assert_called_once_with('mbote', profile='original', model_id='final', segments=[('mbote', 0)])
        with wave.open(io.BytesIO(r.data)) as f:
            self.assertEqual(f.getframerate(), 16000)

    def test_invalid_expired_and_nonadmin_users_never_get_inference(self):
        for status in [401, 403]:
            self.access.authorize.side_effect = AccessError('Denied', status)
            r = self.client.post('/api/voice/synthesize', json={'text': 'mbote'})
            self.assertEqual(r.status_code, status)
        self.engine.speak.assert_not_called()
        self.access.reserve.assert_not_called()

    def test_quota_is_enforced_before_inference(self):
        self.access.reserve.side_effect = AccessError('Daily limit', 429, 120)
        r = self.client.post('/api/voice/synthesize', json={'text': 'mbote'})
        self.assertEqual(r.status_code, 429)
        self.assertEqual(r.headers['Retry-After'], '120')
        self.engine.speak.assert_not_called()

    def test_rejects_oversized_malformed_and_arbitrary_model_paths(self):
        for value in [None, [], {}, {'text': 123}, {'text': 'mbote', 'model': 'gs://other/model'}, {'text': 'x' * 5000}]:
            r = self.client.post('/api/voice/synthesize', json=value)
            self.assertIn(r.status_code, [400, 413])
        self.engine.speak.assert_not_called()

    def test_failures_are_readable_and_do_not_expose_internal_details(self):
        self.engine.speak.side_effect = RuntimeError('secret internal details')
        r = self.client.post('/api/voice/synthesize', json={'text': 'mbote'})
        self.assertEqual(r.status_code, 503)
        self.assertNotIn(b'secret', r.data)

    def test_delivery_and_checkpoint_are_bounded_and_returned_for_comparison(self):
        r = self.client.post('/api/voice/synthesize', json={'text': 'Mbote, matondi.', 'profile': 'steady', 'model': 'step-2000'})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers['X-Voice-Model'], 'step-2000')
        self.assertEqual(r.headers['X-Voice-Profile'], 'steady')
        self.engine.speak.assert_called_once_with('mbote matondi', profile='steady', model_id='step-2000',
                                                 segments=[('mbote', .12), ('matondi', 0)])
        for extra in [{'profile': {}}, {'profile': 'unknown'}, {'model': []}, {'model': '../../model'}]:
            self.assertEqual(self.client.post('/api/voice/synthesize', json={'text': 'mbote', **extra}).status_code, 400)


if __name__ == '__main__':
    unittest.main()
