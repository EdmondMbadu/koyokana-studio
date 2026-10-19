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
  const suffix = task === 'tts' ? (ttsImageDigest ? `@${ttsImageDigest}` : ':v1.0.1') : ':latest';
  return `${region}-docker.pkg.dev/${projectId}/${artifactRepo}/${task}-train${suffix}`;
}

export function trainingCommand(
  run: TrainingRun,
  cloud: CloudTraining,
  machine: { machineType: string; accelerator: string; count: number },
): string {
  if (!/^[A-Za-z0-9_-]+$/.test(run.id)) throw new Error('Invalid run ID');
  const { projectId, region } = cloud;
  const spec = {
    ...(run.task === 'tts' ? { serviceAccount: `tts-trainer@${projectId}.iam.gserviceaccount.com` } : {}),
    scheduling: { timeout: '14400s', restartJobOnWorkerRestart: false },
    workerPoolSpecs: [{
      machineSpec: { machineType: machine.machineType, acceleratorType: machine.accelerator, acceleratorCount: machine.count },
      replicaCount: 1,
      diskSpec: { bootDiskType: 'pd-ssd', bootDiskSizeGb: 100 },
      containerSpec: {
        imageUri: run.trainerImage || trainingImage(run.task, cloud),
        args: [
          `--manifest=${run.manifestUri}`, `--base-model=${run.baseModel}`,
          `--epochs=${run.hyperparams.epochs}`, `--learning-rate=${run.hyperparams.learningRate}`,
          `--batch-size=${run.hyperparams.batchSize}`, `--output=${run.outputUri}`, `--run-id=${run.id}`,
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
