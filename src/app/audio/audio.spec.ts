import { analyzeTake } from './qc';
import { encodeWav } from './wav';

function tone(seconds: number, rate: number, amp: number, lead = 0.3, tail = 0.3): Float32Array {
  const n = Math.round((lead + seconds + tail) * rate);
  const out = new Float32Array(n);
  const start = Math.round(lead * rate);
  const end = start + Math.round(seconds * rate);
  for (let i = start; i < end; i++) out[i] = amp * Math.sin((2 * Math.PI * 180 * i) / rate);
  return out;
}

describe('encodeWav', () => {
  it('writes a valid 24-bit mono PCM header', async () => {
    const blob = encodeWav(new Float32Array(48000), 48000, 24);
    const view = new DataView(await blob.arrayBuffer());
    const str = (o: number) => String.fromCharCode(...new Uint8Array(view.buffer, o, 4));
    expect(str(0)).toBe('RIFF');
    expect(str(8)).toBe('WAVE');
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint16(34, true)).toBe(24);
    expect(view.getUint32(40, true)).toBe(48000 * 3);
    expect(blob.size).toBe(44 + 48000 * 3);
  });

  it('encodes full-scale samples without overflow', async () => {
    const blob = encodeWav(new Float32Array([1, -1, 2, -2]), 16000, 16);
    const view = new DataView(await blob.arrayBuffer());
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
    expect(view.getInt16(48, true)).toBe(32767);
  });
});

describe('analyzeTake', () => {
  it('measures edges and passes a clean take', () => {
    const qc = analyzeTake(tone(2, 48000, 0.3), 48000, 'Mbote, ozali malamu');
    expect(qc.flags).toEqual([]);
    expect(qc.leadingSilence).toBeCloseTo(0.3, 1);
    expect(qc.trailingSilence).toBeCloseTo(0.3, 1);
    expect(qc.speechDuration).toBeCloseTo(2, 1);
  });

  it('flags clipping, quiet takes and silence', () => {
    expect(analyzeTake(tone(1, 48000, 1.2), 48000, 'abc').flags).toContain('clipping');
    expect(analyzeTake(tone(1, 48000, 0.02), 48000, 'abc').flags).toContain('too_quiet');
    expect(analyzeTake(new Float32Array(48000), 48000, 'abc').flags).toEqual(['no_speech']);
    expect(analyzeTake(tone(1, 48000, 0.3, 2.5, 0.2), 48000, 'abc').flags).toContain('long_lead');
  });
});
