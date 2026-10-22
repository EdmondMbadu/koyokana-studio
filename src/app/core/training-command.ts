import { TrainingRun } from './models';

const quote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";

interface CloudTraining {
  projectId: string;
  region: string;
  artifactRepo: string;
  ttsImageDigest?: string;
}

export function trainingImage(task: TrainingRun['task'], cloud: CloudTraining): string {
  const { projectId, region, artifactRepo, ttsImageDigest } = cloud;
  const suffix = task === 'tts' ? (ttsImageDigest ? `@${ttsImageDigest}` : ':v1.1.0') : ':latest';
  return `${region}-docker.pkg.dev/${projectId}/${artifactRepo}/${task}-train${suffix}`;
}

export function trainingCommand(
  run: TrainingRun,
  cloud: CloudTraining,
  machine: { machineType: string; accelerator: string; count: number },
): string {
  if (!/^[A-Za-z0-9_-]+$/.test(run.id)) throw new Error('Invalid run ID');
  const timeout = run.timeoutSeconds ?? 14400;
  if (!Number.isInteger(timeout) || timeout < 3600 || timeout > 604800) throw new Error('Invalid runtime limit');
  const { projectId, region } = cloud;
  const spec = {
    ...(run.task === 'tts' ? { serviceAccount: `tts-trainer@${projectId}.iam.gserviceaccount.com` } : {}),
    scheduling: { timeout: `${timeout}s`, restartJobOnWorkerRestart: false },
    workerPoolSpecs: [{
      machineSpec: { machineType: machine.machineType, acceleratorType: machine.accelerator, acceleratorCount: machine.count },
      replicaCount: 1,
      diskSpec: { bootDiskType: 'pd-ssd', bootDiskSizeGb: 100 },
      containerSpec: {
        imageUri: run.trainerImage || trainingImage(run.task, cloud),
        ...(run.cudnnV7Fallback ? { env: [{ name: 'TORCH_CUDNN_V8_API_DISABLED', value: '1' }] } : {}),
        args: [
          `--manifest=${run.manifestUri}`, `--base-model=${run.baseModel}`,
          `--epochs=${run.hyperparams.epochs}`, `--learning-rate=${run.hyperparams.learningRate}`,
          `--batch-size=${run.hyperparams.batchSize}`, `--output=${run.outputUri}`, `--run-id=${run.id}`,
          ...(run.resumeFrom ? [`--resume-from=${run.resumeFrom}`] : []),
          ...(run.checkpointEverySteps ? [`--save-steps=${run.checkpointEverySteps}`] : []),
          ...(run.targetSteps ? [`--max-steps=${run.targetSteps}`] : []),
          ...(run.adaptation ? [`--adaptation=${run.adaptation}`] : []),
          ...(run.initialModel ? [`--initial-model=${run.initialModel}`] : []),
        ],
      },
    }],
  };
  const file = `koyokana-run-${run.id}.json`;
  // JSON preserves spaces/commas in args; shell quoting handles arbitrary run names.
  return [
    `cat > ${quote(file)} <<'KOYOKANA_JOB_SPEC'`,
    JSON.stringify(spec, null, 2),
    'KOYOKANA_JOB_SPEC',
    'gcloud ai custom-jobs create \\',
    `  --project=${quote(projectId)} \\`,
    `  --region=${quote(region)} \\`,
    `  --display-name=${quote(run.name)} \\`,
    `  --config=${quote(file)}`,
  ].join('\n');
}
