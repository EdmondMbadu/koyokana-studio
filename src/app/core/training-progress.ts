export interface TrainingProgress { step: number; target: number; percent: number; updated: number }

export function trainingProgress(value: unknown, target: number): TrainingProgress {
  const v = value as { step?: number; time?: number };
  if (!Number.isInteger(target) || target <= 0 || !Number.isInteger(v?.step)
    || v.step! < 0 || v.step! > target || !Number.isFinite(v.time) || v.time! <= 0)
    throw new Error('Invalid live training progress');
  return { step: v.step!, target, percent: 100 * v.step! / target, updated: v.time! * 1000 };
}

export function latestTrainingMetric(names: string[]): string | undefined {
  return names.filter(n => /^step-[0-9]{8}-train\.json$/.test(n)).sort().at(-1);
}
