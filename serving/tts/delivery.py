"""Versioned, bounded delivery trials. These are candidates, not quality scores."""
import re

from text import normalize_text, speech_text

PROFILES = {
    'original': {'noise_scale': 0.667, 'noise_scale_duration': 0.8, 'speaking_rate': 1.0},
    'steady': {'noise_scale': 0.45, 'noise_scale_duration': 0.5, 'speaking_rate': 1.0},
    'gentle': {'noise_scale': 0.35, 'noise_scale_duration': 0.35, 'speaking_rate': 0.95},
}
MODEL_IDS = ('final', 'step-2000', 'step-4000', 'step-6000', 'step-8000', 'kinshasa-1000', 'kinshasa-2000')


def delivery_plan(value, vocab, profile):
    if not isinstance(profile, str) or profile not in PROFILES:
        raise ValueError('Choose one of the available delivery styles.')
    text = speech_text(value, vocab)  # Validate the entire input before splitting it.
    if profile == 'original':
        return text, [(text, 0)]
    # Punctuation is not in the learned vocabulary. Synthesize clauses separately
    # and insert real PCM silence, never invent a "pause token" or extra spaces.
    parts = re.split(r'([,;:.!?…\n]+)', value)
    segments = []
    for i in range(0, len(parts), 2):
        normalized = normalize_text(re.sub(r'\s+', ' ', parts[i]))
        if not re.search('[a-z]', normalized):
            continue
        boundary = parts[i + 1] if i + 1 < len(parts) else ''
        gap = 0.26 if re.search(r'[.!?…\n]', boundary) else 0.12 if boundary else 0
        segments.append((normalized, gap))
    if not segments or len(segments) > 8:
        raise ValueError('Use up to eight short phrases per passage.')
    segments[-1] = (segments[-1][0], 0)  # No artificial trailing silence.
    if ' '.join(s for s, _ in segments) != text:
        raise ValueError('Use words between punctuation marks.')
    return text, segments
