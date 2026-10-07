import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  QueryConstraint,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  where,
} from 'firebase/firestore';
import { analyzeTake, QC_LABELS } from '../../audio/qc';
import { MAX_TAKE_SECONDS, Recorder, Take } from '../../audio/recorder';
import { UploadQueue } from '../../audio/upload-queue';
import { encodeWav } from '../../audio/wav';
import { AuthService } from '../../core/auth.service';
import { db } from '../../core/firebase';
import { clock, formatDuration } from '../../core/format';
import { QcFlag, QcReport, ScriptMeta, Sentence } from '../../core/models';
import { StatsService } from '../../core/stats.service';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../ui/icon';
import { LevelMeter } from '../../ui/level-meter';
import { LiveBars } from '../../ui/live-bars';
import { Waveform } from '../../ui/waveform';

const PAGE = 25;
const AUTOPLAY_KEY = 'ks.autoplay';

@Component({
  selector: 'app-record',
  imports: [FormsModule, RouterLink, Icon, LevelMeter, LiveBars, Waveform],
  templateUrl: './record.html',
  styleUrl: './record.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'onKey($event)' },
})
export class Record {
  protected readonly recorder = inject(Recorder);
  protected readonly uploads = inject(UploadQueue);
  protected readonly auth = inject(AuthService);
  protected readonly stats = inject(StatsService);
  private readonly toast = inject(ToastService);

  private readonly wave = viewChild<Waveform>('wave');

  // queue
  protected readonly queue = signal<Sentence[]>([]);
  protected readonly loadingQueue = signal(true);
  protected readonly queueError = signal<string | null>(null);
  protected readonly exhausted = signal(false);
  protected readonly skipped = signal<Sentence[]>([]);
  protected readonly categories = signal<string[]>([]);
  protected readonly category = signal('');
  private cursorSeq: number | null = null;
  private loadToken = 0;

  // take
  protected readonly take = signal<Take | null>(null);
  protected readonly qc = signal<QcReport | null>(null);
  protected readonly takeNumber = signal(1);
  protected readonly stopping = signal(false);
  protected readonly autoplay = signal(readFlag(AUTOPLAY_KEY, true));

  // session
  protected readonly sessionStart = signal<number | null>(null);
  protected readonly sessionClips = signal(0);
  protected readonly sessionSeconds = signal(0);
  protected readonly now = signal(Date.now());

  protected readonly current = computed(() => this.queue()[0] ?? null);
  protected readonly upcoming = computed(() => this.queue()[1] ?? null);
  protected readonly phase = computed<'idle' | 'recording' | 'review'>(() =>
    this.recorder.recording() ? 'recording' : this.take() ? 'review' : 'idle',
  );
  protected readonly micReady = computed(() => this.recorder.state() === 'ready');
  protected readonly flags = computed(() => this.qc()?.flags ?? []);
  protected readonly blocking = computed(() => this.flags().includes('no_speech'));
  protected readonly sessionClock = computed(() => {
    const s = this.sessionStart();
    return s ? clock((this.now() - s) / 1000) : '00:00';
  });
  protected readonly promptSize = computed(() => {
    const n = this.current()?.text.length ?? 0;
    return n > 220 ? 'sm' : n > 120 ? 'md' : 'lg';
  });

  protected readonly QC_LABELS = QC_LABELS;
  protected readonly MAX = MAX_TAKE_SECONDS;
  protected readonly clock = clock;
  protected readonly formatDuration = formatDuration;

  constructor() {
    this.recorder.open();
    this.loadCategories();
    this.reloadQueue();

    const timer = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(timer);
      this.recorder.close();
    });

    // Hard stop at the maximum take length.
    effect(() => {
      if (this.recorder.recording() && this.recorder.elapsed() >= MAX_TAKE_SECONDS) {
        this.toast.show(`Takes are capped at ${MAX_TAKE_SECONDS} seconds.`);
        this.stopTake();
      }
    });
  }

  // ───────────────────────────── queue

  protected setCategory(c: string) {
    if (this.recorder.recording()) return;
    this.category.set(c);
    this.discardTake();
    this.skipped.set([]);
    this.reloadQueue();
  }

  protected reloadQueue() {
    this.cursorSeq = null;
    this.queue.set([]);
    this.exhausted.set(false);
    this.loadingQueue.set(true);
    this.fetchMore();
  }

  private async fetchMore(): Promise<void> {
    if (this.exhausted()) return;
    const token = ++this.loadToken;
    const constraints: QueryConstraint[] = [where('status', '==', 'open')];
    if (this.category()) constraints.push(where('category', '==', this.category()));
    constraints.push(orderBy('seq'));
    if (this.cursorSeq !== null) constraints.push(startAfter(this.cursorSeq));
    constraints.push(limit(PAGE));
    try {
      const snap = await getDocs(query(collection(db, 'sentences'), ...constraints));
      if (token !== this.loadToken) return;
      const rows = snap.docs.map((d) => ({ ...(d.data() as Omit<Sentence, 'id'>), id: d.id }));
      if (rows.length) this.cursorSeq = rows[rows.length - 1]!.seq;
      if (rows.length < PAGE) this.exhausted.set(true);
      const have = new Set(this.queue().map((s) => s.id));
      const skippedIds = new Set(this.skipped().map((s) => s.id));
      this.queue.update((q) => [...q, ...rows.filter((r) => !have.has(r.id) && !skippedIds.has(r.id))]);
      this.queueError.set(null);
    } catch (err) {
      if (token !== this.loadToken) return;
      console.error(err);
      this.queueError.set(err instanceof Error ? err.message : String(err));
    } finally {
      if (token === this.loadToken) this.loadingQueue.set(false);
    }
  }

  private async loadCategories() {
    try {
      const snap = await getDoc(doc(db, 'meta', 'script'));
      this.categories.set(((snap.data() as ScriptMeta | undefined)?.categories ?? []).slice().sort());
    } catch {
      /* optional */
    }
  }

  private advance() {
    this.queue.update((q) => q.slice(1));
    this.takeNumber.set(1);
    this.take.set(null);
    this.qc.set(null);
    if (this.queue().length < 6 && !this.exhausted()) this.fetchMore();
  }

  protected skip() {
    const s = this.current();
    if (!s || this.recorder.recording()) return;
    this.skipped.update((list) => [...list, s]);
    this.advance();
  }

  protected restoreSkipped() {
    const list = this.skipped();
    this.skipped.set([]);
    this.queue.update((q) => [...list, ...q]);
  }

  // ───────────────────────────── takes

  protected async retryMic() {
    await this.recorder.open();
  }

  protected selectMic(id: string) {
    if (this.recorder.recording()) return;
    this.recorder.selectDevice(id);
  }

  protected toggleAutoplay(v: boolean) {
    this.autoplay.set(v);
    writeFlag(AUTOPLAY_KEY, v);
  }

  protected startTake() {
    if (!this.current() || !this.micReady() || this.recorder.recording() || this.stopping()) return;
    if (this.take()) this.takeNumber.update((n) => n + 1);
    this.wave()?.pause();
    this.take.set(null);
    this.qc.set(null);
    this.sessionStart.update((s) => s ?? Date.now());
    this.recorder.start();
  }

  protected async stopTake() {
    if (!this.recorder.recording() || this.stopping()) return;
    this.stopping.set(true);
    try {
      const take = await this.recorder.stop();
      if (!take || take.duration < 0.2) {
        this.toast.show('That take was too short — try again.');
        return;
      }
      this.qc.set(analyzeTake(take.samples, take.sampleRate, this.current()?.text ?? ''));
      this.take.set(take);
      if (this.autoplay()) setTimeout(() => this.wave()?.play(0), 60);
    } finally {
      this.stopping.set(false);
    }
  }

  protected toggleRecord() {
    if (this.recorder.recording()) this.stopTake();
    else this.startTake();
  }

  protected discardTake() {
    if (this.recorder.recording()) this.recorder.cancel();
    if (this.take()) this.takeNumber.update((n) => n + 1);
    this.wave()?.pause();
    this.take.set(null);
    this.qc.set(null);
  }

  protected accept() {
    const take = this.take();
    const sentence = this.current();
    const qc = this.qc();
    const user = this.auth.user();
    const profile = this.auth.profile();
    if (!take || !sentence || !qc || !user || this.blocking()) return;

    const clipId = doc(collection(db, 'clips')).id;
    const blob = encodeWav(take.samples, take.sampleRate, 24);
    const duration = Math.round(take.duration * 1000) / 1000;
    this.uploads.enqueue(
      clipId,
      {
        sentenceId: sentence.id,
        text: sentence.text,
        originalText: sentence.text,
        textEdited: false,
        category: sentence.category,
        speakerId: user.uid,
        speakerName: profile?.speaker?.name || this.auth.displayName(),
        storagePath: `recordings/${user.uid}/${clipId}.wav`,
        durationSec: duration,
        sampleRate: take.sampleRate,
        bitDepth: 24,
        channels: 1,
        sizeBytes: blob.size,
        qc,
        hasFlags: qc.flags.length > 0,
        status: 'pending',
        source: 'studio',
      },
      blob,
    );
    this.sessionClips.update((n) => n + 1);
    this.sessionSeconds.update((s) => s + duration);
    this.wave()?.pause();
    this.advance();
  }

  protected flagLabel(f: QcFlag) {
    return QC_LABELS[f].label;
  }

  // ───────────────────────────── keyboard

  protected onKey(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.closest('input, textarea, select, [contenteditable="true"]') || t.isContentEditable)) return;
    if (document.querySelector('.overlay')) return;

    switch (e.key) {
      case ' ':
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur?.();
        if (this.phase() === 'review') {
          this.discardTake();
          this.startTake();
        } else this.toggleRecord();
        break;
      case 'Enter':
        if (this.phase() === 'review') {
          e.preventDefault();
          this.accept();
        }
        break;
      case 'r':
      case 'R':
        if (this.phase() === 'review') this.discardTake();
        break;
      case 'p':
      case 'P':
        if (this.phase() === 'review') this.wave()?.toggle();
        break;
      case 's':
      case 'S':
      case 'ArrowRight':
        if (this.phase() !== 'recording') this.skip();
        break;
      case 'Escape':
        if (this.phase() === 'recording') this.recorder.cancel();
        break;
    }
  }
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, v: boolean) {
  try {
    localStorage.setItem(key, v ? '1' : '0');
  } catch {
    /* ignore */
  }
}
