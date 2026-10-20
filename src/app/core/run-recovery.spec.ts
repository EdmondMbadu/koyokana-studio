import { TrainingRun } from './models';
import { listeningRunId } from './run-recovery';

describe('listening recovery links', () => {
  const original = { id: 'original', task: 'tts', datasetId: 'tts-v1', recoveryRunId: 'recovered' } as TrainingRun;
  const recovered = { id: 'recovered', task: 'tts', datasetId: 'tts-v1', recoveryOf: 'original' } as TrainingRun;
  it('follows the old link to the correctly related recovery attempt', () => {
    expect(listeningRunId([original, recovered], 'original')).toBe('recovered');
    expect(listeningRunId([original], 'original')).toBe('original');
  });
  it('rejects mismatched datasets or unrelated attempts', () => {
    expect(() => listeningRunId([original, { ...recovered, datasetId: 'other' }], 'original')).toThrow();
    expect(() => listeningRunId([original, { ...recovered, recoveryOf: 'other' }], 'original')).toThrow();
  });
  it('rejects cycles instead of hanging the page', () => {
    expect(() => listeningRunId([{ ...original, recoveryOf: 'recovered' },
      { ...recovered, recoveryRunId: 'original' }], 'original')).toThrow();
  });
});
