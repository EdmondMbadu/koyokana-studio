import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  QueryConstraint,
  QueryDocumentSnapshot,
  collection,
  doc,
  documentId,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAfter,
  updateDoc,
  where,
} from 'firebase/firestore';
import { getDownloadURL, ref, uploadString } from 'firebase/storage';
import { AuthService } from '../../core/auth.service';
import { bucketName, db, storage } from '../../core/firebase';
import { audioAmount, formatDuration, hours, relativeTime } from '../../core/format';
import { Clip, Dataset, DatasetTask, MEMBER_ROLES, UserProfile } from '../../core/models';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../ui/icon';

const SCAN_PAGE = 1000;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{1,47}$/;

interface ScanResult {
  clips: Clip[];
  durationSec: number;
  excludedFlagged: number;
  excludedDuration: number;
  scanned: number;
  speakers: { id: string; name: string; clips: number }[];
  evalCount: number;
}

@Component({
  selector: 'app-datasets',
  imports: [FormsModule, Icon],
  templateUrl: './datasets.html',
  styleUrl: './datasets.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Datasets {
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

  protected readonly datasets = signal<Dataset[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly speakers = signal<UserProfile[]>([]);

  // create
  protected readonly createOpen = signal(false);
  protected readonly name = signal('');
  protected readonly task = signal<DatasetTask>('tts');
  protected readonly speakerId = signal('');
  protected readonly includeFlagged = signal(false);
  protected readonly minDuration = signal(1);
  protected readonly maxDuration = signal(20);
  protected readonly evalPercent = signal(2);
  protected readonly notes = signal('');
  protected readonly scanning = signal(false);
  protected readonly scanProgress = signal(0);
  protected readonly scan = signal<ScanResult | null>(null);
  protected readonly freezing = signal(false);
  protected readonly createError = signal<string | null>(null);

  // detail
  protected readonly selected = signal<Dataset | null>(null);
  protected readonly detailNotes = signal('');
  protected readonly savingNotes = signal(false);

  protected readonly nameValid = computed(() => NAME_RE.test(this.name()));
  protected readonly totals = computed(() => {
    const list = this.datasets();
    return { count: list.length, latest: list[0] ?? null };
  });

  protected readonly hours = hours;
  protected amount(sec: number) {
    const a = audioAmount(sec);
    return `${a.value} ${a.unit}`;
  }
  protected readonly formatDuration = formatDuration;
  protected readonly relativeTime = relativeTime;

  constructor() {
    this.load();
    this.loadSpeakers();
  }

  private async load() {
    this.loading.set(true);
    try {
      const snap = await getDocs(query(collection(db, 'datasets'), orderBy('createdAt', 'desc')));
      this.datasets.set(snap.docs.map((d) => ({ ...(d.data() as Omit<Dataset, 'id'>), id: d.id })));
      this.error.set(null);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loading.set(false);
    }
  }

  private async loadSpeakers() {
    try {
      const snap = await getDocs(query(collection(db, 'users'), where('role', 'in', MEMBER_ROLES)));
      this.speakers.set(snap.docs.map((d) => ({ ...(d.data() as UserProfile), uid: d.id })));
    } catch {
      /* optional */
    }
  }

  // ───────────────────────────── create

  protected openCreate() {
    this.task.set('tts');
    this.name.set(this.suggestName('tts'));
    this.speakerId.set('');
    this.includeFlagged.set(false);
    this.minDuration.set(1);
    this.maxDuration.set(20);
    this.evalPercent.set(2);
    this.notes.set('');
    this.scan.set(null);
    this.createError.set(null);
    this.createOpen.set(true);
  }

  protected closeCreate() {
    if (this.freezing()) return;
    this.createOpen.set(false);
  }

  protected setTask(t: DatasetTask) {
    const auto = this.name() === this.suggestName(this.task());
    this.task.set(t);
    if (auto) this.name.set(this.suggestName(t));
    this.scan.set(null);
  }

  protected invalidate() {
    this.scan.set(null);
  }

  private suggestName(t: DatasetTask): string {
    const taken = new Set(this.datasets().map((d) => d.name));
    let n = this.datasets().filter((d) => d.task === t).length + 1;
    while (taken.has(`${t}-v${n}`)) n++;
    return `${t}-v${n}`;
  }

  protected async runScan() {
    this.scanning.set(true);
    this.scanProgress.set(0);
    this.createError.set(null);
    try {
      const all: Clip[] = [];
      let cursor: QueryDocumentSnapshot | null = null;
      for (;;) {
        const c: QueryConstraint[] = [where('status', '==', 'approved')];
        if (this.speakerId()) c.push(where('speakerId', '==', this.speakerId()));
        c.push(orderBy(documentId()));
        if (cursor) c.push(startAfter(cursor));
        c.push(limit(SCAN_PAGE));
        const snap = await getDocs(query(collection(db, 'clips'), ...c));
        snap.docs.forEach((d) => all.push({ ...(d.data() as Omit<Clip, 'id'>), id: d.id }));
        this.scanProgress.set(all.length);
        if (snap.docs.length < SCAN_PAGE) break;
        cursor = snap.docs.at(-1)!;
      }

      let excludedFlagged = 0;
      let excludedDuration = 0;
      const kept = all.filter((c) => {
        if (!this.includeFlagged() && c.hasFlags) {
          excludedFlagged++;
          return false;
        }
        if (c.durationSec < this.minDuration() || c.durationSec > this.maxDuration()) {
          excludedDuration++;
          return false;
        }
        return true;
      });
      const bySpeaker = new Map<string, { id: string; name: string; clips: number }>();
      for (const c of kept) {
        const s = bySpeaker.get(c.speakerId) ?? { id: c.speakerId, name: c.speakerName, clips: 0 };
        s.clips++;
        bySpeaker.set(c.speakerId, s);
      }
      const pct = this.evalPercent();
      this.scan.set({
        clips: kept,
        durationSec: kept.reduce((a, c) => a + c.durationSec, 0),
        excludedFlagged,
        excludedDuration,
        scanned: all.length,
        speakers: [...bySpeaker.values()].sort((a, b) => b.clips - a.clips),
        evalCount: kept.filter((c) => isEval(c.id, pct)).length,
      });
    } catch (err) {
      this.createError.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.scanning.set(false);
    }
  }

  protected async freeze() {
    const s = this.scan();
    const name = this.name().trim();
    if (!s || !s.clips.length || !this.nameValid() || this.freezing()) return;
    this.freezing.set(true);
    this.createError.set(null);
    try {
      const existing = await getDoc(doc(db, 'datasets', name));
      if (existing.exists()) {
        this.createError.set(`A dataset named “${name}” already exists. Datasets are immutable — pick a new name.`);
        return;
      }
      const pct = this.evalPercent();
      const lines = s.clips.map((c) =>
        JSON.stringify({
          id: c.id,
          audio: `gs://${bucketName}/${c.storagePath}`,
          text: c.text,
          speaker: c.speakerId,
          speaker_name: c.speakerName,
          duration: c.durationSec,
          sample_rate: c.sampleRate,
          category: c.category,
          sentence_id: c.sentenceId,
          split: isEval(c.id, pct) ? 'eval' : 'train',
        }),
      );
      const manifestPath = `datasets/${name}/manifest.jsonl`;
      await uploadString(ref(storage, manifestPath), lines.join('\n') + '\n', 'raw', {
        contentType: 'application/x-ndjson',
        customMetadata: { clips: String(lines.length) },
      });
      const data: Omit<Dataset, 'id' | 'createdAt'> & Record<string, unknown> = {
        name,
        task: this.task(),
        clipCount: s.clips.length,
        trainCount: s.clips.length - s.evalCount,
        evalCount: s.evalCount,
        durationSec: Math.round(s.durationSec * 100) / 100,
        speakers: s.speakers,
        manifestPath,
        manifestUri: `gs://${bucketName}/${manifestPath}`,
        filters: {
          speakerId: this.speakerId() || null,
          includeFlagged: this.includeFlagged(),
          minDuration: this.minDuration(),
          maxDuration: this.maxDuration(),
          evalPercent: pct,
        },
        notes: this.notes().trim(),
        createdAt: serverTimestamp(),
        createdBy: this.auth.user()!.uid,
        createdByName: this.auth.displayName(),
      };
      await setDoc(doc(db, 'datasets', name), data);
      this.toast.success(`Dataset ${name} frozen · ${s.clips.length.toLocaleString()} clips`);
      this.createOpen.set(false);
      await this.load();
    } catch (err) {
      this.createError.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.freezing.set(false);
    }
  }

  // ───────────────────────────── detail

  protected open(d: Dataset) {
    this.selected.set(d);
    this.detailNotes.set(d.notes ?? '');
  }

  protected async saveNotes() {
    const d = this.selected();
    if (!d) return;
    this.savingNotes.set(true);
    try {
      await updateDoc(doc(db, 'datasets', d.id), { notes: this.detailNotes().trim() });
      const updated = { ...d, notes: this.detailNotes().trim() };
      this.datasets.update((l) => l.map((x) => (x.id === d.id ? updated : x)));
      this.selected.set(updated);
      this.toast.success('Notes saved');
    } catch (err) {
      this.toast.error('Couldn’t save notes', err);
    } finally {
      this.savingNotes.set(false);
    }
  }

  protected async copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.toast.success('Copied to clipboard');
    } catch {
      this.toast.error('Clipboard unavailable');
    }
  }

  protected async downloadManifest(d: Dataset) {
    try {
      const url = await getDownloadURL(ref(storage, d.manifestPath));
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      this.toast.error('Couldn’t open the manifest', err);
    }
  }

  protected speakerName(id: string | null): string {
    if (!id) return 'All speakers';
    const s = this.speakers().find((x) => x.uid === id);
    return s?.speaker?.name || s?.displayName || id;
  }
}

/** Deterministic split: the same clip always lands in the same split. */
function isEval(id: string, percent: number): boolean {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 1000 < percent * 10;
}
