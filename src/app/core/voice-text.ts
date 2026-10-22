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
export const VOICE_PROFILES = [
  { id: 'steady', label: 'Steady · v2 trial', description: 'Less variation, with short pauses at punctuation.' },
  { id: 'gentle', label: 'Gentle · v2 trial', description: 'Slightly slower, with less variation and punctuation pauses.' },
  { id: 'original', label: 'Original · v1 comparison', description: 'The original delivery settings, without added pauses.' },
] as const;
export const VOICE_MODELS = [
  { id: 'final', label: 'Final · 9,600 steps' },
  { id: 'kinshasa-1000', label: 'Kinshasa pronunciation trial · +1,000 steps' },
  { id: 'step-2000', label: 'Earlier · 2,000 steps' },
  { id: 'step-4000', label: 'Earlier · 4,000 steps' },
  { id: 'step-6000', label: 'Earlier · 6,000 steps' },
  { id: 'step-8000', label: 'Earlier · 8,000 steps' },
] as const;
export type VoiceProfile = typeof VOICE_PROFILES[number]['id'];
export type VoiceModel = typeof VOICE_MODELS[number]['id'];
const MODEL_SOURCES: Record<VoiceModel, { run: string; step: number }> = {
  final: { run: VOICE_RUN, step: 9600 },
  'kinshasa-1000': { run: 'tts-v2-kinshasa-r1', step: 1000 },
  'step-2000': { run: '157b3de4f137cb77eeb1', step: 2000 },
  'step-4000': { run: '157b3de4f137cb77eeb1', step: 4000 },
  'step-6000': { run: '157b3de4f137cb77eeb1', step: 6000 },
  'step-8000': { run: '157b3de4f137cb77eeb1', step: 8000 },
};

export async function voiceResponse(response: Response, selection?: { profile: VoiceProfile; model: VoiceModel }): Promise<{ blob: Blob; text: string; generationMs: number; duration: number; cached: boolean }> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || (response.status === 429 ? 'Please wait before generating again.' : 'Speech could not be generated. Please try again.'));
  }
  const text = response.headers.get('X-Voice-Text');
  const generationMs = Number(response.headers.get('X-Voice-Generation-Ms'));
  const duration = Number(response.headers.get('X-Voice-Duration'));
  if (selection && (response.headers.get('X-Voice-Version') !== '2'
      || response.headers.get('X-Voice-Profile') !== selection.profile || response.headers.get('X-Voice-Model') !== selection.model
      || response.headers.get('X-Voice-Source-Run') !== MODEL_SOURCES[selection.model].run
      || Number(response.headers.get('X-Voice-Training-Step')) !== MODEL_SOURCES[selection.model].step))
    throw new Error('The voice service did not use the selected version. Refresh the page and try again.');
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
