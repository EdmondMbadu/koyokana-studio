/** Encodes mono float samples as an uncompressed PCM WAV (16- or 24-bit). */
export function encodeWav(samples: Float32Array, sampleRate: number, bitDepth: 16 | 24 = 24): Blob {
  const bytesPerSample = bitDepth / 8;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let o = 44;
  if (bitDepth === 16) {
    for (let i = 0; i < samples.length; i++, o += 2) {
      const s = clamp(samples[i]!);
      view.setInt16(o, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
    }
  } else {
    for (let i = 0; i < samples.length; i++, o += 3) {
      const s = clamp(samples[i]!);
      const v = s < 0 ? Math.round(s * 0x800000) : Math.round(s * 0x7fffff);
      view.setUint8(o, v & 0xff);
      view.setUint8(o + 1, (v >> 8) & 0xff);
      view.setUint8(o + 2, (v >> 16) & 0xff);
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function clamp(x: number): number {
  return x > 1 ? 1 : x < -1 ? -1 : x;
}

function writeString(view: DataView, offset: number, s: string) {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

export function concatFloat32(chunks: Float32Array[]): Float32Array {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export function toDb(amplitude: number): number {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : -120;
}
