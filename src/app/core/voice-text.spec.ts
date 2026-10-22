import { VOICE_RUN, voiceResponse, voiceText } from './voice-text';

function wavResponse(headers: Record<string, string> = {}, bytes?: Uint8Array) {
  const wav = bytes ?? new Uint8Array(100);
  if (!bytes) { wav.set([82, 73, 70, 70]); wav.set([87, 65, 86, 69], 8); }
  return new Response(new Blob([wav as Uint8Array<ArrayBuffer>]), { headers: {
    'Content-Type': 'audio/wav', 'X-Voice-Run': VOICE_RUN, 'X-Voice-Text': 'mbote',
    'X-Voice-Generation-Ms': '123', 'X-Voice-Duration': '2', ...headers,
  } });
}

describe('voice playground text and audio', () => {
  it('previews training spelling without translating Lingala or dropping French letters', () => {
    expect(voiceText('Mbóte, mɔtɔ! crédit; taxi.')).toBe('mbote moto credit taxi');
    expect(voiceText('Œuvre – nakoki koloba.')).toBe('oeuvre - nakoki koloba');
    expect(voiceText('Mbote\nna\tyo')).toBe('mbote na yo');
  });
  it('rejects numbers, symbols, empty speech and oversized passages before a billable request', () => {
    for (const value of ['!!!', '---', 'loba 12', 'loba ١٢', 'mbote 😀', 'a'.repeat(251)])
      expect(() => voiceText(value)).toThrow();
  });
  it('accepts only a complete WAV from the expected trained run', async () => {
    const value = await voiceResponse(wavResponse());
    expect(value.text).toBe('mbote'); expect(value.duration).toBe(2); expect(value.blob.size).toBe(100);
    await expectAsync(voiceResponse(wavResponse({ 'X-Voice-Run': 'other-model' }))).toBeRejected();
    await expectAsync(voiceResponse(wavResponse({ 'Content-Type': 'text/html' }))).toBeRejected();
    await expectAsync(voiceResponse(wavResponse({ 'X-Voice-Duration': 'NaN' }))).toBeRejected();
    await expectAsync(voiceResponse(wavResponse({}, new Uint8Array(100)))).toBeRejected();
  });
  it('shows the server quota error rather than trying to play an error response', async () => {
    await expectAsync(voiceResponse(new Response(JSON.stringify({ error: 'Daily allowance reached' }), {
      status: 429, headers: { 'Content-Type': 'application/json' },
    }))).toBeRejectedWithError('Daily allowance reached');
  });
  it('refuses to play audio from a different checkpoint or delivery trial', async () => {
    await expectAsync(voiceResponse(wavResponse(), { model: 'step-2000', profile: 'steady' })).toBeRejected();
    const result = await voiceResponse(wavResponse({ 'X-Voice-Version': '2', 'X-Voice-Model': 'step-2000', 'X-Voice-Profile': 'steady',
      'X-Voice-Source-Run': '157b3de4f137cb77eeb1', 'X-Voice-Training-Step': '2000' }),
      { model: 'step-2000', profile: 'steady' });
    expect(result.text).toBe('mbote');
    await expectAsync(voiceResponse(wavResponse({ 'X-Voice-Version': '2', 'X-Voice-Model': 'kinshasa-1000', 'X-Voice-Profile': 'gentle',
      'X-Voice-Source-Run': VOICE_RUN, 'X-Voice-Training-Step': '1000' }),
      { model: 'kinshasa-1000', profile: 'gentle' })).toBeRejected();
    const trial2 = { 'X-Voice-Version': '2', 'X-Voice-Model': 'kinshasa-2000', 'X-Voice-Profile': 'gentle',
      'X-Voice-Source-Run': 'tts-v2-kinshasa-r2-recovery-1', 'X-Voice-Training-Step': '2000' };
    expect((await voiceResponse(wavResponse(trial2), { model: 'kinshasa-2000', profile: 'gentle' })).text).toBe('mbote');
    await expectAsync(voiceResponse(wavResponse({ ...trial2, 'X-Voice-Source-Run': 'tts-v2-kinshasa-r1' }),
      { model: 'kinshasa-2000', profile: 'gentle' })).toBeRejected();
  });
});
