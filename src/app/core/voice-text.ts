/** Preview the training normalization; the server validates it again. */
export function voiceText(value: string): string {
  if (value.length > 1000) throw new Error('Enter a short Lingala passage (up to 250 characters).');
  const replacements: Record<string, string> = { 'ɛ': 'e', 'ɔ': 'o', 'œ': 'oe', 'æ': 'ae', '’': "'", 'ʼ': "'", '–': '-', '—': '-' };
  let text = value.replace(/\s+/gu, ' ').toLowerCase().replace(/[ɛɔœæ’ʼ–—]/g, c => replacements[c]);
  text = text.normalize('NFKD').replace(/\p{M}/gu, '');
  if (/\p{Decimal_Number}/u.test(text)) throw new Error('Write numbers as spoken Lingala words, then try again.');
  text = text.replace(/[.,;:!?…"«»]/g, ' ');
  if (/[^a-z '\-]/.test(text)) throw new Error('Use Lingala words and ordinary punctuation. Remove unsupported symbols.');
  text = text.replace(/\s+/g, ' ').trim();
  if (!/[a-z]/.test(text)) throw new Error('Enter some Lingala words first.');
  if (text.length > 250) throw new Error('Use up to 250 characters at a time.');
  return text;
}

export const VOICE_RUN = '157b3de4f137cb77eeb1-recovery-1';

export async function voiceResponse(response: Response): Promise<{ blob: Blob; text: string; generationMs: number; duration: number; cached: boolean }> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || (response.status === 429 ? 'Please wait before generating again.' : 'Speech could not be generated. Please try again.'));
  }
  const text = response.headers.get('X-Voice-Text');
  const generationMs = Number(response.headers.get('X-Voice-Generation-Ms'));
  const duration = Number(response.headers.get('X-Voice-Duration'));
  if (!response.headers.get('Content-Type')?.startsWith('audio/wav') || response.headers.get('X-Voice-Run') !== VOICE_RUN
      || !text || !Number.isFinite(generationMs) || generationMs < 0 || !Number.isFinite(duration) || duration <= 0 || duration > 60)
    throw new Error('The voice service returned an incomplete response. Please try again.');
  const blob = await response.blob();
  if (blob.size < 44 || blob.size > 2 * 1024 * 1024) throw new Error('The generated audio is incomplete. Please try again.');
  const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 12) !== 'WAVE') throw new Error('The generated audio is not a WAV file. Please try again.');
  return { blob, text, generationMs, duration, cached: response.headers.get('X-Voice-Cached') === 'true' };
}
