import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { TitleCasePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  QueryConstraint,
  QueryDocumentSnapshot,
  collection,
  deleteDoc,
  doc,
  getDocs,
  increment,
  limit,
  orderBy,
  query,
  serverTimestamp,
  startAfter,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { deleteObject, getDownloadURL, ref } from 'firebase/storage';
import { QC_LABELS } from '../../audio/qc';
import { AuthService } from '../../core/auth.service';
import { ConfirmService } from '../../core/confirm.service';
import { db, storage } from '../../core/firebase';
import { formatDuration, normalizeText, relativeTime } from '../../core/format';
import { Clip, ClipStatus, MEMBER_ROLES, QcFlag, UserProfile } from '../../core/models';
import { StatsService } from '../../core/stats.service';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../ui/icon';
import { Waveform } from '../../ui/waveform';

type StatusFilter = ClipStatus | 'all';
const PAGE = 40;
const AUTOPLAY_KEY = 'ks.review.autoplay';

@Component({
  selector: 'app-review',
  imports: [FormsModule, TitleCasePipe, Icon, Waveform],
  templateUrl: './review.html',
  styleUrl: './review.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'onKey($event)' },
})
export class Review {
  protected readonly auth = inject(AuthService);
  protected readonly stats = inject(StatsService);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);

  private readonly wave = viewChild<Waveform>('wave');

  protected readonly status = signal<StatusFilter>('pending');
  protected readonly flaggedOnly = signal(false);
  protected readonly speakerId = signal('');
  protected readonly speakers = signal<UserProfile[]>([]);

  protected readonly clips = signal<Clip[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadingMore = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly hasMore = signal(false);
  private cursor: QueryDocumentSnapshot | null = null;
  private loadToken = 0;

  protected readonly selectedId = signal<string | null>(null);
  protected readonly selected = computed(() => this.clips().find((c) => c.id === this.selectedId()) ?? null);
  protected readonly selectedIndex = computed(() => this.clips().findIndex((c) => c.id === this.selectedId()));
  protected readonly audioUrl = signal<string | null>(null);
  protected readonly urlError = signal<string | null>(null);
  protected readonly note = signal('');
  protected readonly editing = signal(false);
  protected readonly draftText = signal('');
  protected readonly saving = signal(false);
  protected readonly autoplay = signal(readFlag(AUTOPLAY_KEY, true));

  private readonly urlCache = new Map<string, string>();

  protected readonly QC_LABELS = QC_LABELS;
  protected readonly formatDuration = formatDuration;
  protected readonly relativeTime = relativeTime;

  protected readonly tabs = computed(() => [
    { value: 'pending' as const, label: 'Pending', count: this.stats.pendingClips() },
    { value: 'approved' as const, label: 'Approved', count: this.stats.approvedClips() },
    { value: 'rejected' as const, label: 'Rejected', count: this.stats.rejectedClips() },
    { value: 'all' as const, label: 'All', count: this.stats.totalClips() },
  ]);

  constructor() {
    this.stats.refresh(0);
    this.loadSpeakers();
    this.reload();

    // Resolve the audio URL whenever the selection changes.
    effect(() => {
      const clip = this.selected();
      this.editing.set(false);
      this.note.set(clip?.reviewNote ?? '');
      this.audioUrl.set(null);
      this.urlError.set(null);
      if (clip) this.resolveUrl(clip);
    });
  }

  // ───────────────────────────── loading

  protected setStatus(s: StatusFilter) {
    this.status.set(s);
    this.reload();
  }

  protected setFlagged(v: boolean) {
    this.flaggedOnly.set(v);
    this.reload();
  }

  protected setSpeaker(id: string) {
    this.speakerId.set(id);
    this.reload();
  }

  protected reload() {
    this.cursor = null;
    this.clips.set([]);
    this.selectedId.set(null);
    this.loading.set(true);
    this.load();
  }

  protected async loadMore() {
    if (this.loadingMore() || !this.hasMore()) return;
    this.loadingMore.set(true);
    await this.load();
    this.loadingMore.set(false);
  }

  private async load() {
    const token = ++this.loadToken;
    const c: QueryConstraint[] = [];
    if (this.status() !== 'all') c.push(where('status', '==', this.status()));
    if (this.flaggedOnly()) c.push(where('hasFlags', '==', true));
    if (this.speakerId()) c.push(where('speakerId', '==', this.speakerId()));
    c.push(orderBy('createdAt', 'desc'));
    if (this.cursor) c.push(startAfter(this.cursor));
    c.push(limit(PAGE));
    try {
      const snap = await getDocs(query(collection(db, 'clips'), ...c));
      if (token !== this.loadToken) return;
      const rows = snap.docs.map((d) => ({ ...(d.data() as Omit<Clip, 'id'>), id: d.id }));
      this.cursor = snap.docs.at(-1) ?? this.cursor;
      this.hasMore.set(snap.docs.length === PAGE);
      this.clips.update((list) => [...list, ...rows]);
      if (!this.selectedId() && rows.length) this.select(rows[0]!.id, false);
      this.error.set(null);
    } catch (err) {
      if (token !== this.loadToken) return;
      console.error(err);
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      if (token === this.loadToken) this.loading.set(false);
    }
  }

  private async loadSpeakers() {
    try {
      const snap = await getDocs(query(collection(db, 'users'), where('role', 'in', MEMBER_ROLES)));
      this.speakers.set(
        snap.docs
          .map((d) => ({ ...(d.data() as UserProfile), uid: d.id }))
          .sort((a, b) => (a.displayName || '').localeCompare(b.displayName || '')),
      );
    } catch {
      /* optional filter */
    }
  }

  private async resolveUrl(clip: Clip) {
    const cached = this.urlCache.get(clip.storagePath);
    if (cached) {
      this.audioUrl.set(cached);
      return;
    }
    try {
      const url = await getDownloadURL(ref(storage, clip.storagePath));
      this.urlCache.set(clip.storagePath, url);
      if (this.selectedId() === clip.id) this.audioUrl.set(url);
    } catch (err) {
      if (this.selectedId() === clip.id) this.urlError.set('Audio file not found in storage.');
      console.warn(err);
    }
  }

  // ───────────────────────────── selection

  protected select(id: string, play = this.autoplay()) {
    this.wave()?.pause();
    this.selectedId.set(id);
    if (play) this.playWhenReady();
  }

  private playWhenReady() {
    const id = this.selectedId();
    let tries = 0;
    const attempt = () => {
      if (this.selectedId() !== id || tries++ > 40) return;
      const w = this.wave();
      if (w && w.duration() > 0 && !w.loading()) w.play(0);
      else setTimeout(attempt, 100);
    };
    setTimeout(attempt, 50);
  }

  protected move(delta: number) {
    const list = this.clips();
    if (!list.length) return;
    const i = this.selectedIndex();
    const next = Math.max(0, Math.min(list.length - 1, (i < 0 ? 0 : i) + delta));
    if (next !== i) {
      this.select(list[next]!.id);
      document.querySelector(`[data-clip="${list[next]!.id}"]`)?.scrollIntoView({ block: 'nearest' });
    }
    if (next >= list.length - 5) this.loadMore();
  }

  protected toggleAutoplay(v: boolean) {
    this.autoplay.set(v);
    try {
      localStorage.setItem(AUTOPLAY_KEY, v ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  // ───────────────────────────── decisions

  protected async decide(to: ClipStatus) {
    const clip = this.selected();
    if (!clip || this.saving()) return;
    const from = clip.status;
    if (from === to && (clip.reviewNote ?? '') === this.note().trim()) {
      this.advanceAfter(clip, to);
      return;
    }
    this.saving.set(true);
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'clips', clip.id), {
        status: to,
        reviewNote: this.note().trim(),
        reviewedBy: this.auth.user()!.uid,
        reviewedByName: this.auth.displayName(),
        reviewedAt: serverTimestamp(),
      });
      // Rejected takes send the sentence back to the recording queue.
      if (to === 'rejected' && from !== 'rejected') {
        batch.update(doc(db, 'sentences', clip.sentenceId), { status: 'open' });
      } else if (from === 'rejected' && to !== 'rejected') {
        batch.update(doc(db, 'sentences', clip.sentenceId), { status: 'recorded' });
      }
      await batch.commit().catch(async (err) => {
        // The sentence may have been deleted — still record the decision on the clip.
        if (/No document to update/i.test(String(err))) {
          await updateDoc(doc(db, 'clips', clip.id), {
            status: to,
            reviewNote: this.note().trim(),
            reviewedBy: this.auth.user()!.uid,
            reviewedByName: this.auth.displayName(),
            reviewedAt: serverTimestamp(),
          });
        } else throw err;
      });
      this.stats.applyReview(clip.durationSec, from, to);
      const updated: Clip = { ...clip, status: to, reviewNote: this.note().trim() };
      this.clips.update((list) => list.map((c) => (c.id === clip.id ? updated : c)));
      this.advanceAfter(updated, to);
    } catch (err) {
      this.toast.error('Couldn’t save the decision', err);
    } finally {
      this.saving.set(false);
    }
  }

  private advanceAfter(clip: Clip, to: ClipStatus) {
    const list = this.clips();
    const i = list.findIndex((c) => c.id === clip.id);
    const leaves = this.status() !== 'all' && this.status() !== to;
    if (leaves) {
      const rest = list.filter((c) => c.id !== clip.id);
      this.clips.set(rest);
      const next = rest[Math.min(i, rest.length - 1)];
      if (next) this.select(next.id);
      else this.selectedId.set(null);
      if (rest.length < 10) this.loadMore();
    } else {
      const next = list[i + 1];
      if (next) this.select(next.id);
    }
  }

  protected startEdit() {
    const clip = this.selected();
    if (!clip) return;
    this.draftText.set(clip.text);
    this.editing.set(true);
    setTimeout(() => (document.querySelector('#clip-text') as HTMLTextAreaElement | null)?.focus(), 0);
  }

  protected async saveText() {
    const clip = this.selected();
    const text = normalizeText(this.draftText());
    if (!clip || !text) return;
    if (text === clip.text) {
      this.editing.set(false);
      return;
    }
    this.saving.set(true);
    try {
      await updateDoc(doc(db, 'clips', clip.id), {
        text,
        textEdited: text !== clip.originalText,
      });
      this.clips.update((list) =>
        list.map((c) => (c.id === clip.id ? { ...c, text, textEdited: text !== c.originalText } : c)),
      );
      this.editing.set(false);
      this.toast.success('Transcript updated');
    } catch (err) {
      this.toast.error('Couldn’t update the transcript', err);
    } finally {
      this.saving.set(false);
    }
  }

  protected async remove() {
    const clip = this.selected();
    if (!clip || !this.auth.isAdmin()) return;
    const ok = await this.confirm.ask({
      title: 'Delete this clip?',
      message: 'The audio file and its record are removed permanently. The sentence returns to the recording queue.',
      confirmLabel: 'Delete clip',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteObject(ref(storage, clip.storagePath)).catch((err) => {
        if (err?.code !== 'storage/object-not-found') throw err;
      });
      await deleteDoc(doc(db, 'clips', clip.id));
      await updateDoc(doc(db, 'sentences', clip.sentenceId), {
        status: 'open',
        recordCount: increment(-1),
      }).catch(() => undefined);
      const list = this.clips();
      const i = list.findIndex((c) => c.id === clip.id);
      const rest = list.filter((c) => c.id !== clip.id);
      this.clips.set(rest);
      const next = rest[Math.min(i, rest.length - 1)];
      this.selectedId.set(next?.id ?? null);
      this.stats.refresh(0);
      this.toast.success('Clip deleted');
    } catch (err) {
      this.toast.error('Couldn’t delete the clip', err);
    }
  }

  protected flagLabel(f: QcFlag) {
    return QC_LABELS[f].label;
  }

  // ───────────────────────────── keyboard

  protected onKey(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && t.closest('input, textarea, select, [contenteditable="true"]')) {
      if (e.key === 'Escape' && this.editing()) this.editing.set(false);
      if (e.key === 'Enter' && this.editing() && t.id === 'clip-text') {
        e.preventDefault();
        this.saveText();
      }
      return;
    }
    if (document.querySelector('.overlay')) return;
    switch (e.key) {
      case 'j':
      case 'J':
      case 'ArrowDown':
        e.preventDefault();
        this.move(1);
        break;
      case 'k':
      case 'K':
      case 'ArrowUp':
        e.preventDefault();
        this.move(-1);
        break;
      case ' ':
        e.preventDefault();
        this.wave()?.toggle();
        break;
      case 'a':
      case 'A':
        this.decide('approved');
        break;
      case 'x':
      case 'X':
        this.decide('rejected');
        break;
      case 'u':
      case 'U':
        this.decide('pending');
        break;
      case 'e':
      case 'E':
        e.preventDefault();
        this.startEdit();
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
