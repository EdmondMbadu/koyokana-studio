import { Injectable, signal } from '@angular/core';
import {
  collection,
  count,
  getAggregateFromServer,
  getCountFromServer,
  query,
  sum,
  where,
} from 'firebase/firestore';
import { db } from './firebase';

/** Workspace-wide counters (server-side aggregation, no full scans). */
@Injectable({ providedIn: 'root' })
export class StatsService {
  readonly loaded = signal(false);
  readonly approvedSec = signal(0);
  readonly approvedClips = signal(0);
  readonly totalSec = signal(0);
  readonly totalClips = signal(0);
  readonly pendingClips = signal(0);
  readonly rejectedClips = signal(0);
  readonly openSentences = signal(0);
  readonly totalSentences = signal(0);

  private lastRefresh = 0;
  private inflight: Promise<void> | null = null;

  /** Refreshes if older than `maxAgeMs`. */
  refresh(maxAgeMs = 15000): Promise<void> {
    if (this.inflight) return this.inflight;
    if (Date.now() - this.lastRefresh < maxAgeMs) return Promise.resolve();
    this.inflight = this.load().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async load(): Promise<void> {
    const clips = collection(db, 'clips');
    const sentences = collection(db, 'sentences');
    try {
      const [approved, all, pending, rejected, open, totalS] = await Promise.all([
        getAggregateFromServer(query(clips, where('status', '==', 'approved')), {
          n: count(),
          s: sum('durationSec'),
        }),
        getAggregateFromServer(clips, { n: count(), s: sum('durationSec') }),
        getCountFromServer(query(clips, where('status', '==', 'pending'))),
        getCountFromServer(query(clips, where('status', '==', 'rejected'))),
        getCountFromServer(query(sentences, where('status', '==', 'open'))),
        getCountFromServer(sentences),
      ]);
      this.approvedClips.set(approved.data().n);
      this.approvedSec.set(approved.data().s ?? 0);
      this.totalClips.set(all.data().n);
      this.totalSec.set(all.data().s ?? 0);
      this.pendingClips.set(pending.data().count);
      this.rejectedClips.set(rejected.data().count);
      this.openSentences.set(open.data().count);
      this.totalSentences.set(totalS.data().count);
      this.lastRefresh = Date.now();
      this.loaded.set(true);
    } catch (err) {
      console.warn('[stats] refresh failed', err);
    }
  }

  /** Optimistic local bump after a successful upload. */
  addRecorded(seconds: number) {
    this.totalSec.update((v) => v + seconds);
    this.totalClips.update((v) => v + 1);
    this.pendingClips.update((v) => v + 1);
    this.openSentences.update((v) => Math.max(0, v - 1));
  }

  /** Optimistic local update after a review decision. */
  applyReview(seconds: number, from: string, to: string) {
    if (from === to) return;
    const bump = (status: string, d: number) => {
      if (status === 'approved') {
        this.approvedClips.update((v) => v + d);
        this.approvedSec.update((v) => Math.max(0, v + d * seconds));
      } else if (status === 'pending') this.pendingClips.update((v) => Math.max(0, v + d));
      else if (status === 'rejected') this.rejectedClips.update((v) => Math.max(0, v + d));
    };
    bump(from, -1);
    bump(to, 1);
  }
}
