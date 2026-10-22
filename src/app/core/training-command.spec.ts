import { trainingCommand } from './training-command';
import { TrainingRun } from './models';

describe('trainingCommand', () => {
  it('reproduces the conservative adaptation experiment', () => {
    const command = trainingCommand({ id: 'v2', name: 'v2', task: 'tts', adaptation: 'pronunciation', initialModel: 'first-voice', targetSteps: 3000,
      checkpointEverySteps: 500, hyperparams: { epochs: 32, batchSize: 8, learningRate: 2e-5 } } as TrainingRun,
      { projectId: 'project', region: 'us-central1', artifactRepo: 'repo' },
      { machineType: 'g2-standard-8', accelerator: 'NVIDIA_L4', count: 1 });
    expect(command).toContain('--adaptation=pronunciation'); expect(command).toContain('--initial-model=first-voice');
    expect(command).toContain('--max-steps=3000');
  });
  it('preserves the recovery checkpoint and absolute target instead of starting over', () => {
    const command = trainingCommand({ id: 'recovery1', name: 'Recovery', task: 'tts', timeoutSeconds: 14400, cudnnV7Fallback: true,
      resumeFrom: 'gs://bucket/runs/original/checkpoints/checkpoint-8000', targetSteps: 9600, checkpointEverySteps: 200,
      hyperparams: { epochs: 100, batchSize: 8, learningRate: 2e-5 } } as TrainingRun,
      { projectId: 'project', region: 'us-central1', artifactRepo: 'repo' },
      { machineType: 'g2-standard-8', accelerator: 'NVIDIA_L4', count: 1 });
    expect(command).toContain('--resume-from=gs://bucket/runs/original/checkpoints/checkpoint-8000');
    expect(command).toContain('--max-steps=9600');
    expect(command).toContain('--save-steps=200');
    const spec = JSON.parse(command.split('\n').slice(1, command.split('\n').indexOf('KOYOKANA_JOB_SPEC')).join('\n'));
    expect(spec.workerPoolSpecs[0].containerSpec.env).toEqual([{ name: 'TORCH_CUDNN_V8_API_DISABLED', value: '1' }]);
  });
  it('preserves an approved eight-hour limit', () => {
    const run = { id: 'run1', name: 'full run', task: 'tts', timeoutSeconds: 28800,
      hyperparams: { epochs: 100, batchSize: 8, learningRate: 2e-5 } } as TrainingRun;
    expect(trainingCommand(run, { projectId: 'project', region: 'us-central1', artifactRepo: 'repo' },
      { machineType: 'g2-standard-8', accelerator: 'NVIDIA_L4', count: 1 })).toContain('"timeout": "28800s"');
    expect(() => trainingCommand({ ...run, timeoutSeconds: NaN },
      { projectId: 'project', region: 'us-central1', artifactRepo: 'repo' },
      { machineType: 'g2-standard-8', accelerator: 'NVIDIA_L4', count: 1 })).toThrowError('Invalid runtime limit');
  });
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
    expect(spec.workerPoolSpecs[0].containerSpec.imageUri).toContain('tts-train:v1.1.0');
  });
});
