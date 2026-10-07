import { QcFlag, QcReport } from '../core/models';
import { toDb } from './wav';

/** Thresholds for automatic quality checks (heuristics — tune as data grows). */
export const QC = {
  clipLevel: 0.999,
  maxClippedSamples: 3,
  minPeakDb: -24,
  maxSpeechRmsDb: -9,
  minSpeech: 0.6,
  maxLead: 1.5,
  maxTail: 2.0,
  maxCps: 18,
  minCps: 5,
};

export const QC_LABELS: Record<QcFlag, { label: string; hint: string }> = {
  clipping: { label: 'Clipping', hint: 'Input too hot — lower the gain or move back.' },
  too_quiet: { label: 'Too quiet', hint: 'Raise the gain or move closer to the mic.' },
  too_loud: { label: 'Too loud', hint: 'Lower the gain slightly.' },
  too_short: { label: 'Too short', hint: 'Very little speech was captured.' },
  long_lead: { label: 'Late start', hint: 'Long silence before speaking.' },
  long_tail: { label: 'Long tail', hint: 'Long silence after speaking.' },
  fast: { label: 'Fast', hint: 'Reading faster than usual.' },
  slow: { label: 'Slow', hint: 'Reading slower than usual, or a long pause.' },
  no_speech: { label: 'No speech', hint: 'Nothing above the noise floor was detected.' },
};

/** Analyses a mono take: levels, silence at the edges and reading speed. */
export function analyzeTake(samples: Float32Array, sampleRate: number, text: string): QcReport {
  let peak = 0;
  let clipped = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]!);
    if (a > peak) peak = a;
    if (a >= QC.clipLevel) clipped++;
  }

  const frame = Math.max(1, Math.round(sampleRate * 0.01)); // 10 ms
  const frames = Math.floor(samples.length / frame);
  const frameDb = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    const start = f * frame;
    for (let i = start; i < start + frame; i++) acc += samples[i]! * samples[i]!;
    frameDb[f] = toDb(Math.sqrt(acc / frame));
  }

  const peakDb = toDb(peak);
  const sorted = Array.from(frameDb).sort((a, b) => a - b);
  const noiseDb = sorted.length ? sorted[Math.floor(sorted.length * 0.1)]! : -120;
  const threshold = Math.max(-55, Math.min(noiseDb + 12, peakDb - 20));

  let first = -1;
  let last = -1;
  for (let f = 0; f < frames; f++) {
    if (frameDb[f]! > threshold) {
      if (first < 0) first = f;
      last = f;
    }
  }

  const duration = samples.length / sampleRate;
  const flags: QcFlag[] = [];
  let lead = duration;
  let tail = 0;
  let speech = 0;
  let speechRmsDb = -120;

  if (first < 0 || peakDb < -50) {
    flags.push('no_speech');
  } else {
    lead = (first * frame) / sampleRate;
    tail = Math.max(0, duration - ((last + 1) * frame) / sampleRate);
    speech = ((last - first + 1) * frame) / sampleRate;
    let acc = 0;
    let n = 0;
    for (let i = first * frame; i < Math.min(samples.length, (last + 1) * frame); i++) {
      acc += samples[i]! * samples[i]!;
      n++;
    }
    speechRmsDb = toDb(Math.sqrt(acc / Math.max(1, n)));
  }

  const letters = (text.match(/\p{L}/gu) ?? []).length;
  const cps = speech > 0 ? letters / speech : 0;

  if (clipped >= QC.maxClippedSamples) flags.push('clipping');
  if (!flags.includes('no_speech')) {
    if (peakDb < QC.minPeakDb) flags.push('too_quiet');
    if (speechRmsDb > QC.maxSpeechRmsDb) flags.push('too_loud');
    if (speech < QC.minSpeech) flags.push('too_short');
    if (lead > QC.maxLead) flags.push('long_lead');
    if (tail > QC.maxTail) flags.push('long_tail');
    if (letters >= 12 && cps > QC.maxCps) flags.push('fast');
    if (letters >= 12 && cps > 0 && cps < QC.minCps) flags.push('slow');
  }

  const r1 = (x: number) => Math.round(x * 10) / 10;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    peakDb: r1(peakDb),
    rmsDb: r1(speechRmsDb),
    clippedSamples: clipped,
    leadingSilence: r2(lead),
    trailingSilence: r2(tail),
    speechDuration: r2(speech),
    charsPerSec: r1(cps),
    flags,
  };
}
