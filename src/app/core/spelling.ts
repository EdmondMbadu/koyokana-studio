// Koyokana spelling rules (see the "Koyokana Script — Spelling Rules" doc).
// Plain e/o, no tone marks, no digits or symbols, French words in French spelling.

export type SpellingIssue =
  | 'digits'
  | 'open-vowels'
  | 'tone-marks'
  | 'symbols'
  | 'abbreviation'
  | 'spacing'
  | 'too-long';

export const SPELLING_ISSUES: Record<SpellingIssue, { label: string; fix: string }> = {
  digits: { label: 'Digits', fix: 'Write numbers as spoken words (mille cinq cents francs).' },
  'open-vowels': { label: 'ɛ / ɔ', fix: 'Use plain e and o.' },
  'tone-marks': { label: 'Tone marks', fix: 'Remove tone accents (á í ó ú ǎ). French é è ê stay.' },
  symbols: { label: 'Symbols', fix: 'Spell out %, $, &, /, brackets and similar.' },
  abbreviation: { label: 'Abbreviation', fix: 'Write the full words (s’il vous plaît, Madame, francs).' },
  spacing: { label: 'Spacing', fix: 'Join verb pieces: kokende, not ko kende.' },
  'too-long': { label: 'Too long', fix: 'Split sentences over 250 characters.' },
};

const MAX_LENGTH = 250;
const OPEN_VOWELS = /[ɛɔƐƆ]/u;
// Accents that are never French: acute on a/i/o/u, carons, and stray combining tone marks.
const TONE_MARKS = /[áíóúÁÍÓÚǎěǐǒǔǍĚǏǑǓ]|[̀-ͯ]/u;
const SYMBOLS = /[%$€£&@#/\\<>[\]{}()=+*_|~^`]/u;
const ABBREVIATIONS =
  /(^|[\s,.;:!?])(svp|stp|mr|mme|mlle|mrs|etc|fc|cdf|usd|km|kg|tel|n°|no\.)(?=$|[\s,.;:!?])/iu;
const SPLIT_INFINITIVE = /(^|\s)ko[\s-]+\p{L}/u;

/** Returns every rule a script sentence breaks (empty = clean). */
export function checkSpelling(text: string): SpellingIssue[] {
  const t = text.normalize('NFC');
  const issues: SpellingIssue[] = [];
  if (/\d/.test(t)) issues.push('digits');
  if (OPEN_VOWELS.test(t)) issues.push('open-vowels');
  if (TONE_MARKS.test(t)) issues.push('tone-marks');
  if (SYMBOLS.test(t)) issues.push('symbols');
  if (ABBREVIATIONS.test(t)) issues.push('abbreviation');
  if (SPLIT_INFINITIVE.test(t)) issues.push('spacing');
  if (t.length > MAX_LENGTH) issues.push('too-long');
  return issues;
}

/** Safe automatic fixes: ɛ→e, ɔ→o, strip non-French tone accents. Never touches digits. */
export function autoFix(text: string): string {
  return text
    .normalize('NFD')
    .replace(/([ɛɔƐƆ])[\u0300-\u036f]+/gu, '$1') // tone marks on open vowels
    .replace(/ɛ/g, 'e')
    .replace(/Ɛ/g, 'E')
    .replace(/ɔ/g, 'o')
    .replace(/Ɔ/g, 'O')
    .replace(/([aiouAIOU])\u0301/gu, '$1') // acute is only French on e (é)
    .replace(/([aeiouAEIOU])\u030c/gu, '$1') // carons are never French
    .normalize('NFC');
}
