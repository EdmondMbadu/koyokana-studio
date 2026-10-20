/** Versioned blind-test protocol. A stored seed makes reloads keep the same order. */
export const LISTEN_PROTOCOL = 1;
export const VARIANTS = ['original', 'processed', 'baseline', 'trained'] as const;
export type VoiceVariant = typeof VARIANTS[number];
export interface VoiceSample {
  id: string; text: string; kind: 'held-out' | 'unseen-phone';
  reference_uri?: string | null; processed_reference_uri?: string;
  baseline_uri: string; trained_uri: string;
}
export interface SampleIndex { schema_version: 1; run_id: string; samples: VoiceSample[] }
export interface ListenTrial {
  id: string; sample: VoiceSample; variant: VoiceVariant; uri: string;
  phase: 'transcription' | 'rating'; letter: string; sentenceNumber: number;
}
export interface ListenResponse {
  listenerId: string; runId: string; sampleId: string; variant: VoiceVariant;
  phase: 'transcription' | 'rating'; heard: boolean;
  intelligibility: number; naturalness: number; soundsLikeEdmond: boolean;
  transcript: string;
}
export const VOICE_LABELS: Record<VoiceVariant, string> = {
  original: 'Original recording', processed: 'Processed recording',
  baseline: 'UBC original voice', trained: 'Trained voice',
};

export function sampleUri(sample: VoiceSample, variant: VoiceVariant): string | undefined {
  return ({ original: sample.reference_uri ?? undefined, processed: sample.processed_reference_uri,
    baseline: sample.baseline_uri, trained: sample.trained_uri })[variant];
}

export function validateSampleIndex(value: unknown, runId: string, bucket: string): SampleIndex {
  const v = value as SampleIndex;
  if (v?.schema_version !== 1 || v.run_id !== runId || !Array.isArray(v.samples)
    || !v.samples.length || v.samples.length > 1000) throw new Error('Invalid sample index');
  const ids = new Set<string>();
  for (const sample of v.samples) {
    if (!sample || typeof sample.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sample.id)
      || ids.has(sample.id) || typeof sample.text !== 'string' || !sample.text.trim()
      || !['held-out', 'unseen-phone'].includes(sample.kind)) throw new Error('Invalid or duplicate sample');
    ids.add(sample.id);
    for (const variant of VARIANTS) {
      const uri = sampleUri(sample, variant);
      const required = sample.kind === 'held-out' || variant === 'baseline' || variant === 'trained';
      if (!required && !uri) continue;
      const prefix = variant === 'original' ? `gs://${bucket}/recordings/` : `gs://${bucket}/runs/${runId}/samples/`;
      if (typeof uri !== 'string' || !uri.startsWith(prefix) || !uri.endsWith('.wav')
        || uri.includes('..') || uri.includes('?') || uri.includes('#')) throw new Error('Sample audio is outside this run');
    }
  }
  if (!v.samples.some(s => s.kind === 'held-out')) throw new Error('No held-out samples');
  return v;
}

function random(seed: number) {
  let n = seed >>> 0;
  return () => { n += 0x6D2B79F5; let t = n;
    t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
export function listenTrials(index: SampleIndex, seed: number): ListenTrial[] {
  const rand = random(seed);
  // Write-down tests come first, before any transcript or alternate voice is shown.
  const heldOut = shuffle(index.samples.filter(s => s.kind === 'held-out'), rand).slice(0, 10);
  const cycle = shuffle(VARIANTS, rand);
  const writeDown = heldOut.map((sample, i): ListenTrial => ({
    id: `t-${i}`, sample, variant: cycle[i % cycle.length],
    uri: sampleUri(sample, cycle[i % cycle.length])!, phase: 'transcription', letter: 'A', sentenceNumber: i + 1,
  }));
  const ratings: ListenTrial[] = [];
  for (const [i, sample] of shuffle(index.samples, rand).entries()) {
    const available = VARIANTS.filter(v => !!sampleUri(sample, v));
    for (const [j, variant] of shuffle(available, rand).entries()) ratings.push({
      id: `r-${ratings.length}`, sample, variant, uri: sampleUri(sample, variant)!,
      phase: 'rating', letter: String.fromCharCode(65 + j), sentenceNumber: i + 1,
    });
  }
  return [...writeDown, ...ratings];
}

/** Case, accents and punctuation ignored; errors / reference words, never capped at 100%. */
export function wordErrors(reference: string, hypothesis: string): { errors: number; words: number } {
  const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
  const a = words(reference), b = words(hypothesis);
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return { errors: row[b.length], words: a.length };
}

export function listeningSummary(index: SampleIndex, responses: ListenResponse[]) {
  return (['held-out', 'unseen-phone'] as const).flatMap(kind => VARIANTS.map(variant => {
    const samples = new Map(index.samples.filter(s => s.kind === kind).map(s => [s.id, s]));
    const selected = responses.filter(r => r.variant === variant && samples.has(r.sampleId));
    const ratings = selected.filter(r => r.phase === 'rating');
    const writes = selected.filter(r => r.phase === 'transcription');
    const errorCounts = writes.map(r => wordErrors(samples.get(r.sampleId)!.text, r.transcript));
    const errors = errorCounts.reduce((s, r) => s + r.errors, 0), words = errorCounts.reduce((s, r) => s + r.words, 0);
    return { kind, variant, label: VOICE_LABELS[variant], ratings: ratings.length,
      listeners: new Set(selected.map(r => r.listenerId)).size,
      intelligibility: ratings.length ? ratings.reduce((s, r) => s + r.intelligibility, 0) / ratings.length : null,
      naturalness: ratings.length ? ratings.reduce((s, r) => s + r.naturalness, 0) / ratings.length : null,
      recognition: ratings.length ? ratings.filter(r => r.soundsLikeEdmond).length / ratings.length : null,
      transcriptions: writes.length, errors, words, wer: words ? errors / words : null };
  })).filter(r => r.ratings || r.transcriptions);
}
