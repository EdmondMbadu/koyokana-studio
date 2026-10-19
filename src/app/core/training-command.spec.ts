import { trainingCommand } from './training-command';
import { TrainingRun } from './models';

describe('trainingCommand', () => {
  it('preserves the planned image if the configured release later changes', () => {
    const run = { id: 'run1', name: 'first run', task: 'tts', trainerImage: 'registry/tts@sha256:frozen',
      manifestUri: 'gs://bucket/manifest.jsonl', baseModel: 'UBC-NLP/Simba-TTS-lin',
      outputUri: 'gs://bucket/runs/run1/', hyperparams: { epochs: 1, batchSize: 1, learningRate: 2e-5 } } as TrainingRun;
    const command = trainingCommand(run,
      { projectId: 'project', region: 'us-central1', artifactRepo: 'koyokana', ttsImageDigest: 'sha256:new' },
      { machineType: 'g2-standard-8', accelerator: 'NVIDIA_L4', count: 1 });
    expect(command).toContain('registry/tts@sha256:frozen');
    expect(command).not.toContain('sha256:new');
  });
  it('preserves argument values, limits runtime and selects the dedicated identity', () => {
    const command = trainingCommand({ id: 'run1', name: "Edmond's first run $(false)",
      task: 'tts', manifestUri: 'gs://bucket/datasets/tts-v1/manifest.jsonl',
      baseModel: 'UBC-NLP/Simba-TTS-lin', outputUri: 'gs://bucket/runs/run1/',
      hyperparams: { epochs: 100, batchSize: 8, learningRate: 2e-5 } } as TrainingRun,
      { projectId: 'project', region: 'us-central1', artifactRepo: 'koyokana' },
      { machineType: 'g2-standard-8', accelerator: 'NVIDIA_L4', count: 1 });
    const spec = JSON.parse(command.split('\n').slice(1, command.split('\n').indexOf('KOYOKANA_JOB_SPEC')).join('\n'));
    expect(spec.serviceAccount).toBe('tts-trainer@project.iam.gserviceaccount.com');
    expect(spec.scheduling.timeout).toBe('14400s');
    expect(spec.workerPoolSpecs[0].containerSpec.args).toContain('--base-model=UBC-NLP/Simba-TTS-lin');
    expect(command).toContain(`--display-name='Edmond'"'"'s first run $(false)'`);
    expect(spec.workerPoolSpecs[0].containerSpec.imageUri).toContain('tts-train:v1.0.1');
  });
});
