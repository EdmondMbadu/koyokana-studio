import { Injectable, computed, inject, signal } from '@angular/core';
import {
  doc,
  increment,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';
import { getMetadata, ref, uploadBytesResumable } from 'firebase/storage';
import { db, storage } from '../core/firebase';
import { dayKey } from '../core/format';
import { Clip } from '../core/models';
import { StatsService } from '../core/stats.service';

export type UploadStatus = 'queued' | 'uploading' | 'saving' | 'done' | 'failed';

export interface UploadJob {
  id: string;
  clip: Omit<Clip, 'id' | 'createdAt'>;
  blob: Blob;
  status: UploadStatus;
  progress: number;
  attempts: number;
  uploaded: boolean;
  error: string | null;
  queuedAt: number;
}

const CONCURRENCY = 2;
const AUTO_RETRIES = 3;

/**
 * Background upload pipeline: WAV → Cloud Storage, then one atomic Firestore batch
 * (clip doc + sentence status + daily counter). Lets the speaker keep recording.
 */
@Injectable({ providedIn: 'root' })
export class UploadQueue {
  private readonly stats = inject(StatsService);

  readonly jobs = signal<UploadJob[]>([]);
  readonly activeCount = computed(
    () => this.jobs().filter((j) => j.status === 'queued' || j.status === 'uploading' || j.status === 'saving').length,
  );
  readonly failedCount = computed(() => this.jobs().filter((j) => j.status === 'failed').length);
  readonly doneCount = signal(0);
  readonly visible = computed(() => this.jobs().slice(-6).reverse());

  private running = 0;

  hasUnfinished(): boolean {
    return this.activeCount() > 0 || this.failedCount() > 0;
  }

  enqueue(id: string, clip: UploadJob['clip'], blob: Blob): void {
    const job: UploadJob = {
      id,
      clip,
      blob,
      status: 'queued',
      progress: 0,
      attempts: 0,
      uploaded: false,
      error: null,
      queuedAt: Date.now(),
    };
    this.jobs.update((list) => [...list, job]);
    this.pump();
  }

  retry(id: string): void {
    this.patch(id, { status: 'queued', error: null, attempts: 0 });
    this.pump();
  }

  retryAll(): void {
    for (const j of this.jobs()) if (j.status === 'failed') this.patch(j.id, { status: 'queued', error: null, attempts: 0 });
    this.pump();
  }

  discard(id: string): void {
    this.jobs.update((list) => list.filter((j) => j.id !== id));
  }

  // ───────────────────────────── internals

  private pump(): void {
    while (this.running < CONCURRENCY) {
      const next = this.jobs().find((j) => j.status === 'queued');
      if (!next) return;
      this.running++;
      this.patch(next.id, { status: next.uploaded ? 'saving' : 'uploading' });
      this.run(next.id).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async run(id: string): Promise<void> {
    const job = this.jobs().find((j) => j.id === id);
    if (!job) return;
    const attempt = job.attempts + 1;
    this.patch(id, { attempts: attempt });

    try {
      if (!job.uploaded) {
        await this.upload(job);
        this.patch(id, { uploaded: true, progress: 1, status: 'saving' });
      }
      await this.save(job);
      this.patch(id, { status: 'done', progress: 1 });
      this.doneCount.update((n) => n + 1);
      this.stats.addRecorded(job.clip.durationSec);
      // Release the audio blob; keep a short trail of finished jobs for the UI.
      setTimeout(() => {
        this.jobs.update((list) => {
          const keep = list.filter((j) => j.status !== 'done' || Date.now() - j.queuedAt < 30000);
          return keep.length > 30 ? keep.filter((j) => j.status !== 'done') : keep;
        });
      }, 31000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[upload] attempt', attempt, 'failed', err);
      if (attempt < AUTO_RETRIES) {
        this.patch(id, { status: 'queued', error: message });
        await sleep(800 * 2 ** attempt);
      } else {
        this.patch(id, { status: 'failed', error: friendly(message) });
      }
    }
  }

  private async upload(job: UploadJob): Promise<void> {
    const r = ref(storage, job.clip.storagePath);
    // A previous attempt may have completed the upload before failing to report back.
    if (job.attempts > 0) {
      const meta = await getMetadata(r).catch(() => null);
      if (meta && meta.size === job.blob.size) return;
    }
    await new Promise<void>((resolve, reject) => {
      const task = uploadBytesResumable(r, job.blob, {
        contentType: 'audio/wav',
        customMetadata: { sentenceId: job.clip.sentenceId, speakerId: job.clip.speakerId },
      });
      task.on(
        'state_changed',
        (s) => this.patch(job.id, { progress: s.totalBytes ? s.bytesTransferred / s.totalBytes : 0 }),
        reject,
        () => resolve(),
      );
    });
  }

  private async save(job: UploadJob): Promise<void> {
    const batch = writeBatch(db);
    batch.set(doc(db, 'clips', job.id), { ...job.clip, createdAt: serverTimestamp() });
    batch.update(doc(db, 'sentences', job.clip.sentenceId), {
      status: 'recorded',
      recordCount: increment(1),
      lastRecordedAt: serverTimestamp(),
      lastRecordedBy: job.clip.speakerId,
    });
    const day = dayKey(new Date(job.queuedAt));
    batch.set(
      doc(db, 'daily', day),
      { date: day, clips: increment(1), seconds: increment(job.clip.durationSec), updatedAt: serverTimestamp() },
      { merge: true },
    );
    await batch.commit();
  }

  private patch(id: string, patch: Partial<UploadJob>): void {
    this.jobs.update((list) => list.map((j) => (j.id === id ? { ...j, ...patch } : j)));
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function friendly(message: string): string {
  if (/unauthorized|permission/i.test(message)) return 'Permission denied — check your role and the security rules.';
  if (/network|offline|retry-limit/i.test(message)) return 'Network error — check your connection.';
  if (/No document to update/i.test(message)) return 'The sentence was deleted from the script.';
  return message;
}
