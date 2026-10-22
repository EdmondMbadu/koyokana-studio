import unittest

from delivery import delivery_plan

VOCAB = {c: i for i, c in enumerate("abcdefghijklmnopqrstuvwxyz '-")}


class DeliveryTests(unittest.TestCase):
    def test_legacy_preserves_one_unbroken_generation(self):
        text, segments = delivery_plan('Mbote, nakoki kosalisa yo? Matondi.', VOCAB, 'original')
        self.assertEqual(segments, [(text, 0)])

    def test_real_pauses_keep_every_word_once_and_have_no_trailing_silence(self):
        text, segments = delivery_plan('Mbote, nakoki kosalisa yo?\nMatondi!', VOCAB, 'steady')
        self.assertEqual(segments, [('mbote', .12), ('nakoki kosalisa yo', .26), ('matondi', 0)])
        self.assertEqual(' '.join(s for s, _ in segments), text)
        self.assertEqual(delivery_plan('Mbote\tna yo.', VOCAB, 'steady')[1], [('mbote na yo', 0)])

    def test_invalid_and_excessively_fragmented_input_never_reaches_inference(self):
        for value, profile in [('mbote 12', 'steady'), ('mbote', 'other'), (', '.join(['mbote'] * 9), 'steady')]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                delivery_plan(value, VOCAB, profile)
