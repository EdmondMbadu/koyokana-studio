import { TrainingRun } from './models';

/** Keep old listening links useful while preserving each attempt's provenance. */
export function listeningRunId(runs: TrainingRun[], requested: string): string {
  let current = runs.find(r => r.id === requested);
  const visited = new Set<string>();
  while (current?.recoveryRunId) {
    if (visited.has(current.id)) throw new Error('Training recovery links contain a cycle');
    visited.add(current.id);
    const next = runs.find(r => r.id === current!.recoveryRunId);
    if (!next) break; // A registry refresh may still be loading a new attempt.
    if (next.datasetId !== current.datasetId || next.task !== current.task || next.recoveryOf !== current.id)
      throw new Error('Training recovery link does not match the original dataset and run');
    current = next;
  }
  return current?.id ?? requested;
}
