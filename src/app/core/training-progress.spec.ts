import { latestTrainingMetric, trainingProgress } from './training-progress';

describe('live recovery progress', () => {
  it('shows the absolute restored step rather than counting from zero', () => {
    expect(trainingProgress({ step: 8400, time: 100 }, 9600)).toEqual({ step: 8400, target: 9600, percent: 87.5, updated: 100000 });
  });
  it('rejects corrupt or misleading progress', () => {
    for (const value of [{ step: 9601, time: 100 }, { step: -1, time: 100 }, { step: 1, time: NaN }, { step: 1.5, time: 100 }])
      expect(() => trainingProgress(value, 9600)).toThrow();
    expect(() => trainingProgress({ step: 1, time: 100 }, NaN)).toThrow();
  });
  it('finds the newest training snapshot without using evaluation files', () => {
    expect(latestTrainingMetric(['step-00008400-train.json', 'step-00008500-eval.json', 'step-00008350-train.json', 'unexpected.json'])).toBe('step-00008400-train.json');
  });
});
