import { ListenResponse, SampleIndex, listenTrials, listeningSummary, validateSampleIndex, wordErrors } from './listening-test';

const sampleIndex = (): SampleIndex => ({ schema_version: 1, run_id: 'run1', samples: [
  ...Array.from({ length: 33 }, (_, i) => ({ id: `eval-${i}`, text: 'mbote na yo', kind: 'held-out' as const,
    reference_uri: `gs://bucket/recordings/speaker/clip${i}.wav`,
    processed_reference_uri: `gs://bucket/runs/run1/samples/eval-${i}-reference.wav`,
    baseline_uri: `gs://bucket/runs/run1/samples/eval-${i}-baseline.wav`,
    trained_uri: `gs://bucket/runs/run1/samples/eval-${i}-trained.wav` })),
  ...Array.from({ length: 10 }, (_, i) => ({ id: `phone-${i}`, text: 'mbote na yo', kind: 'unseen-phone' as const,
    baseline_uri: `gs://bucket/runs/run1/samples/phone-${i}-baseline.wav`,
    trained_uri: `gs://bucket/runs/run1/samples/phone-${i}-trained.wav` })),
] });

describe('blind listening protocol', () => {
  it('keeps reload order stable, changes listener order, and covers all available versions', () => {
    const a = listenTrials(sampleIndex(), 1), b = listenTrials(sampleIndex(), 2);
    expect(a).toEqual(listenTrials(sampleIndex(), 1));
    expect(a.map(t => t.uri)).not.toEqual(b.map(t => t.uri));
    expect(a.filter(t => t.phase === 'rating').length).toBe(152);
    expect(new Set(a.map(t => t.id)).size).toBe(a.length);
    expect(a.filter(t => t.sample.kind === 'unseen-phone').every(t => ['baseline', 'trained'].includes(t.variant))).toBeTrue();
  });
  it('puts ten unique held-out write-downs first and balances versions within one', () => {
    const trials = listenTrials(sampleIndex(), 10), first = trials.slice(0, 10);
    expect(first.every(t => t.phase === 'transcription' && t.sample.kind === 'held-out')).toBeTrue();
    expect(new Set(first.map(t => t.sample.id)).size).toBe(10);
    const counts = ['original', 'processed', 'baseline', 'trained'].map(v => first.filter(t => t.variant === v).length);
    expect(Math.max(...counts) - Math.min(...counts)).toBe(1);
    expect(trials.slice(10).every(t => t.phase === 'rating')).toBeTrue();
  });
  it('rejects missing references, another run, an external bucket and duplicate prompts', () => {
    expect(validateSampleIndex(sampleIndex(), 'run1', 'bucket').samples.length).toBe(43);
    const missing = sampleIndex(); delete missing.samples[0].processed_reference_uri;
    expect(() => validateSampleIndex(missing, 'run1', 'bucket')).toThrow();
    const external = sampleIndex(); external.samples[0].trained_uri = 'gs://external/file.wav';
    expect(() => validateSampleIndex(external, 'run1', 'bucket')).toThrow();
    expect(() => validateSampleIndex(sampleIndex(), 'another-run', 'bucket')).toThrow();
    const duplicate = sampleIndex(); duplicate.samples.push(duplicate.samples[0]);
    expect(() => validateSampleIndex(duplicate, 'run1', 'bucket')).toThrow();
  });
});

describe('listening scores', () => {
  it('counts substitutions, deletions and insertions, and folds case, accents and punctuation', () => {
    expect(wordErrors('Mbóte, na yo!', 'mbote na yo')).toEqual({ errors: 0, words: 3 });
    expect(wordErrors('mbote na yo', 'mbote ya')).toEqual({ errors: 2, words: 3 });
    expect(wordErrors('mbote', 'mbote na yo lelo')).toEqual({ errors: 3, words: 1 });
    expect(wordErrors('mbote na yo', '')).toEqual({ errors: 3, words: 3 });
  });
  it('uses word-weighted WER and keeps phone scores separate, with no fake reference scores', () => {
    const index = sampleIndex(); index.samples[1].text = 'mbote';
    const base = { listenerId: 'listener', runId: 'run1', variant: 'trained', heard: true,
      intelligibility: 4, naturalness: 3, soundsLikeEdmond: true, transcript: '' } as const;
    const responses: ListenResponse[] = [
      { ...base, sampleId: 'eval-0', phase: 'transcription', transcript: 'mbote na yo' },
      { ...base, sampleId: 'eval-1', phase: 'transcription', transcript: '' },
      { ...base, sampleId: 'eval-0', phase: 'rating' },
      { ...base, sampleId: 'phone-0', phase: 'rating', intelligibility: 1 },
    ];
    const summary = listeningSummary(index, responses);
    expect(summary.length).toBe(2);
    expect(summary[0].wer).toBe(0.25);
    expect(summary[0].intelligibility).toBe(4);
    expect(summary[0].recognition).toBe(1);
    expect(summary[1].intelligibility).toBe(1);
    expect(summary[1].wer).toBeNull();
  });
});
