import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/auth.service';
import { ConfirmService } from '../../core/confirm.service';
import { bucketName, db } from '../../core/firebase';
import { audioAmount, hours, relativeTime } from '../../core/format';
import { Dataset, DatasetTask, RunStatus, TrainingRun } from '../../core/models';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../ui/icon';
import { trainingCommand, trainingImage } from '../../core/training-command';

interface Machine {
  id: string;
  label: string;
  machineType: string;
  accelerator: string;
  count: number;
  approxHourly: string;
}

export const MACHINES: Machine[] = [
  { id: 'l4', label: '1× NVIDIA L4 (24 GB)', machineType: 'g2-standard-8', accelerator: 'NVIDIA_L4', count: 1, approxHourly: '≈ $1/h' },
  { id: 'a100', label: '1× NVIDIA A100 (40 GB)', machineType: 'a2-highgpu-1g', accelerator: 'NVIDIA_TESLA_A100', count: 1, approxHourly: '≈ $3.40/h' },
  { id: 'h100', label: '1× NVIDIA H100 (80 GB)', machineType: 'a3-highgpu-1g', accelerator: 'NVIDIA_H100_80GB', count: 1, approxHourly: '≈ $11/h' },
];

const BASE_MODELS: Record<DatasetTask, { id: string; label: string }[]> = {
  tts: [
    { id: 'UBC-NLP/Simba-TTS-lin', label: 'Simba Lingala (MMS / VITS)' },
  ],
  stt: [
    { id: 'facebook/mms-1b-all', label: 'MMS-1B all (Lingala adapter)' },
    { id: 'openai/whisper-large-v3', label: 'Whisper large-v3' },
  ],
};

const DEFAULTS: Record<DatasetTask, TrainingRun['hyperparams']> = {
  tts: { epochs: 100, learningRate: 2e-5, batchSize: 8 },
  stt: { epochs: 20, learningRate: 1e-3, batchSize: 16 },
};

export const RUN_STATUSES: { value: RunStatus; label: string; cls: string }[] = [
  { value: 'planned', label: 'Planned', cls: '' },
  { value: 'running', label: 'Running', cls: 'badge-blue' },
  { value: 'succeeded', label: 'Succeeded', cls: 'badge-green' },
  { value: 'failed', label: 'Failed', cls: 'badge-red' },
  { value: 'cancelled', label: 'Cancelled', cls: 'badge-outline' },
];

@Component({
  selector: 'app-training',
  imports: [FormsModule, Icon],
  templateUrl: './training.html',
  styleUrl: './training.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Training {
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);

  protected readonly runs = signal<TrainingRun[]>([]);
  protected readonly datasets = signal<Dataset[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  // create
  protected readonly createOpen = signal(false);
  protected readonly datasetId = signal('');
  protected readonly baseModel = signal('');
  protected readonly machineId = signal('l4');
  protected readonly runName = signal('');
  protected readonly epochs = signal(100);
  protected readonly learningRate = signal(2e-5);
  protected readonly batchSize = signal(8);
  protected readonly runtimeHours = signal(8);
  protected readonly gitCommit = signal('');
  protected readonly runNotes = signal('');
  protected readonly creating = signal(false);

  protected readonly dataset = computed(() => this.datasets().find((d) => d.id === this.datasetId()) ?? null);
  protected readonly models = computed(() => BASE_MODELS[this.dataset()?.task ?? 'tts']);

  // detail
  protected readonly selected = signal<TrainingRun | null>(null);
  protected readonly edit = signal<Partial<TrainingRun> & { wer?: string; cer?: string; mos?: string }>({});
  protected readonly savingRun = signal(false);

  protected readonly machines = MACHINES;
  protected readonly statuses = RUN_STATUSES;
  protected readonly hours = hours;
  protected amount(sec: number) {
    const a = audioAmount(sec);
    return `${a.value} ${a.unit}`;
  }
  protected readonly relativeTime = relativeTime;
  protected readonly consoleUrl = `https://console.cloud.google.com/vertex-ai/training/custom-jobs?project=${environment.gcp.projectId}`;

  constructor() {
    this.load();
  }

  private async load() {
    this.loading.set(true);
    try {
      const [runs, ds] = await Promise.all([
        getDocs(query(collection(db, 'runs'), orderBy('createdAt', 'desc'))),
        getDocs(query(collection(db, 'datasets'), orderBy('createdAt', 'desc'))),
      ]);
      this.runs.set(runs.docs.map((d) => ({ ...(d.data() as Omit<TrainingRun, 'id'>), id: d.id })));
      this.datasets.set(ds.docs.map((d) => ({ ...(d.data() as Omit<Dataset, 'id'>), id: d.id })));
      this.error.set(null);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loading.set(false);
    }
  }

  // ───────────────────────────── create

  protected openCreate() {
    const first = this.datasets()[0];
    this.datasetId.set(first?.id ?? '');
    this.onDatasetChange(first?.id ?? '');
    this.machineId.set('l4');
    this.gitCommit.set('');
    this.runNotes.set('');
    this.createOpen.set(true);
  }

  protected onDatasetChange(id: string) {
    this.datasetId.set(id);
    const d = this.datasets().find((x) => x.id === id);
    const task = d?.task ?? 'tts';
    this.baseModel.set(BASE_MODELS[task][0]!.id);
    const h = DEFAULTS[task];
    this.epochs.set(h.epochs);
    this.learningRate.set(h.learningRate);
    this.batchSize.set(h.batchSize);
    this.runtimeHours.set(task === 'tts' ? 8 : 4);
    this.runName.set(d ? this.suggestName(d) : '');
  }

  private suggestName(d: Dataset) {
    const n = this.runs().filter((r) => r.datasetId === d.id).length + 1;
    return `${d.name}-r${n}`;
  }

  protected async create() {
    const d = this.dataset();
    if (!d || !this.runName().trim() || this.creating()) return;
    if (!Number.isInteger(this.runtimeHours()) || this.runtimeHours() < 1 || this.runtimeHours() > 168) {
      this.toast.error('Use a maximum runtime between 1 and 168 whole hours');
      return;
    }
    if (d.task === 'tts' && (d.speakers.length !== 1 || !d.trainCount || !d.evalCount)) {
      this.toast.error('TTS needs a frozen dataset with one speaker and nonempty train/eval splits');
      return;
    }
    if (!Number.isInteger(this.epochs()) || this.epochs() < 1 || this.epochs() > 500 ||
        !Number.isInteger(this.batchSize()) || this.batchSize() < 1 || this.batchSize() > 32 ||
        !Number.isFinite(this.learningRate()) || this.learningRate() <= 0 || this.learningRate() > 0.001) {
      this.toast.error('Use 1–500 epochs, a batch size of 1–32, and a learning rate greater than zero and at most 0.001');
      return;
    }
    this.creating.set(true);
    try {
      const machine = MACHINES.find((m) => m.id === this.machineId())!;
      const ref = doc(collection(db, 'runs'));
      const run: Omit<TrainingRun, 'id' | 'createdAt' | 'updatedAt'> & Record<string, unknown> = {
        name: this.runName().trim(),
        task: d.task,
        datasetId: d.id,
        datasetName: d.name,
        manifestUri: d.manifestUri,
        baseModel: this.baseModel(),
        trainerImage: trainingImage(d.task, environment.gcp),
        timeoutSeconds: this.runtimeHours() * 3600,
        machine: machine.id,
        hyperparams: {
          epochs: Number(this.epochs()) || 1,
          learningRate: Number(this.learningRate()) || 1e-4,
          batchSize: Number(this.batchSize()) || 8,
        },
        gitCommit: this.gitCommit().trim(),
        vertexJobId: '',
        outputUri: `gs://${bucketName}/runs/${ref.id}/`,
        status: 'planned',
        metrics: { wer: null, cer: null, mos: null },
        notes: this.runNotes().trim(),
        createdAt: serverTimestamp(),
        createdBy: this.auth.user()!.uid,
        createdByName: this.auth.displayName(),
        updatedAt: serverTimestamp(),
      };
      await setDoc(ref, run);
      this.createOpen.set(false);
      await this.load();
      const created = this.runs().find((r) => r.id === ref.id);
      if (created) this.open(created);
      this.toast.success('Run planned — copy the launch command');
    } catch (err) {
      this.toast.error('Couldn’t create the run', err);
    } finally {
      this.creating.set(false);
    }
  }

  // ───────────────────────────── detail

  protected open(r: TrainingRun) {
    this.selected.set(r);
    this.edit.set({
      status: r.status,
      vertexJobId: r.vertexJobId,
      outputUri: r.outputUri,
      gitCommit: r.gitCommit,
      notes: r.notes,
      wer: r.metrics?.wer?.toString() ?? '',
      cer: r.metrics?.cer?.toString() ?? '',
      mos: r.metrics?.mos?.toString() ?? '',
    });
  }

  protected patch(key: string, value: string) {
    this.edit.update((e) => ({ ...e, [key]: value }));
  }

  protected async saveRun() {
    const r = this.selected();
    const e = this.edit();
    if (!r) return;
    this.savingRun.set(true);
    const num = (v?: string) => (v === undefined || v.trim() === '' || isNaN(+v) ? null : +v);
    const patch = {
      status: e.status ?? r.status,
      vertexJobId: (e.vertexJobId ?? '').trim(),
      outputUri: (e.outputUri ?? '').trim(),
      gitCommit: (e.gitCommit ?? '').trim(),
      notes: (e.notes ?? '').trim(),
      metrics: { wer: num(e.wer), cer: num(e.cer), mos: num(e.mos) },
    };
    try {
      await updateDoc(doc(db, 'runs', r.id), { ...patch, updatedAt: serverTimestamp() });
      const updated = { ...r, ...patch } as TrainingRun;
      this.runs.update((l) => l.map((x) => (x.id === r.id ? updated : x)));
      this.selected.set(updated);
      this.toast.success('Run saved');
    } catch (err) {
      this.toast.error('Couldn’t save the run', err);
    } finally {
      this.savingRun.set(false);
    }
  }

  protected async remove(r: TrainingRun) {
    const ok = await this.confirm.ask({
      title: `Delete run “${r.name}”?`,
      message: 'This removes the record from the registry. Files in Cloud Storage and Vertex AI are not touched.',
      confirmLabel: 'Delete run',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteDoc(doc(db, 'runs', r.id));
      this.runs.update((l) => l.filter((x) => x.id !== r.id));
      this.selected.set(null);
    } catch (err) {
      this.toast.error('Couldn’t delete the run', err);
    }
  }

  protected command(r: TrainingRun): string {
    const m = MACHINES.find((x) => x.id === r.machine) ?? MACHINES[0]!;
    return trainingCommand(r, environment.gcp, m);
  }

  protected statusOf(s: RunStatus) {
    return RUN_STATUSES.find((x) => x.value === s) ?? RUN_STATUSES[0]!;
  }

  protected machineLabel(id: string) {
    return MACHINES.find((m) => m.id === id)?.label ?? id;
  }

  protected modelLabel(id: string) {
    return Object.values(BASE_MODELS)
      .flat()
      .find((m) => m.id === id)?.label ?? id;
  }

  protected metricsSummary(r: TrainingRun): string {
    const parts: string[] = [];
    if (r.metrics?.wer != null) parts.push(`WER ${r.metrics.wer}`);
    if (r.metrics?.cer != null) parts.push(`CER ${r.metrics.cer}`);
    if (r.metrics?.mos != null) parts.push(`MOS ${r.metrics.mos}`);
    return parts.join(' · ') || '—';
  }

  protected async copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.toast.success('Copied to clipboard');
    } catch {
      this.toast.error('Clipboard unavailable');
    }
  }
}
