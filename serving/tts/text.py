"""Use the exact normalization that produced the trained voice. No translation."""
import re
import unicodedata


def normalize_text(text):
    # Simba's vocabulary has no accented French vowels. Transliterate them rather
    # than letting VitsTokenizer silently delete entire letters (crédit -> crdit).
    text = text.lower().translate(str.maketrans({'ɛ': 'e', 'ɔ': 'o', 'œ': 'oe',
        'æ': 'ae', '’': "'", 'ʼ': "'", '–': '-', '—': '-'}))
    text = ''.join(c for c in unicodedata.normalize('NFKD', text)
                   if not unicodedata.combining(c))
    if re.search(r'\d', text):
        raise ValueError('Write numbers as spoken Lingala words, then try again.')
    text = re.sub(r'[.,;:!?…"«»]', ' ', text)
    if re.search(r"[^a-z '\-]", text):
        raise ValueError(f'Unsupported characters in transcript: {text}')
    return ' '.join(text.split())


def speech_text(value, vocab):
    if not isinstance(value, str) or len(value) > 1000:
        raise ValueError("Enter a short Lingala passage (up to 250 characters).")
    text = normalize_text(re.sub(r'\s+', ' ', value))
    if not text or not re.search("[a-z]", text):
        raise ValueError("Enter some Lingala words first.")
    if len(text) > 250:
        raise ValueError("Use up to 250 characters at a time.")
    unsupported = sorted(set(text) - set(vocab))
    if unsupported:
        raise ValueError("The voice cannot read these characters: " + " ".join(unsupported))
    return text
