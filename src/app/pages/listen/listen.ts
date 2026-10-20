import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { collection, doc, getDocs, orderBy, query, runTransaction, serverTimestamp, updateDoc } from 'firebase/firestore';
import { getBlob, ref } from 'firebase/storage';
import { AuthService } from '../../core/auth.service';
import { bucketName, db, storage } from '../../core/firebase';
import { LISTEN_PROTOCOL, ListenResponse, SampleIndex, listenTrials, listeningSummary, validateSampleIndex } from '../../core/listening-test';
import { TrainingRun } from '../../core/models';
import { Icon } from '../../ui/icon';

interface ListenSession { uid: string; runId: string; protocolVersion: number; indexSha256: string; seed: number; revealedAt?: unknown }

@Component({
  selector: 'app-listen', imports: [FormsModule, RouterLink, Icon],
  templateUrl: './listen.html', styleUrl: './listen.css', changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Listen {
  protected readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  protected readonly runs = signal<TrainingRun[]>([]);
  protected readonly runId = signal('');
  protected readonly index = signal<SampleIndex | null>(null);
  protected readonly seed = signal(0);
  protected readonly answers = signal<Record<string, ListenResponse>>({});
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly waiting = signal(false);
  protected readonly audioUrl = signal('');
  protected readonly audioLoading = signal(false);
  protected readonly heard = signal(false);
  protected readonly intelligibility = signal(0);
  protected readonly naturalness = signal(0);
  protected readonly soundsLikeEdmond = signal<boolean | null>(null);
  protected readonly transcript = signal('');
  protected readonly unintelligible = signal(false);
  protected readonly showResults = signal(false);
  protected readonly results = signal<ReturnType<typeof listeningSummary>>([]);
  protected readonly resultsLoading = signal(false);
  protected readonly allResponses = signal<ListenResponse[]>([]);
  private loadVersion = 0;
  private indexHash = '';
  private sessionRevealed = false;
  protected readonly trials = computed(() => this.index() ? listenTrials(this.index()!, this.seed()) : []);
  protected readonly current = computed(() => this.trials().find(t => !this.answers()[t.id]) ?? null);
  protected readonly completed = computed(() => this.trials().filter(t => !!this.answers()[t.id]).length);
  protected readonly transcriptionCount = computed(() => this.trials().filter(t => t.phase === 'transcription').length);
  protected readonly finished = computed(() => !!this.index() && !this.current());
  protected readonly canSave = computed(() => this.heard() && !this.audioLoading() && !this.saving() && (
    this.current()?.phase === 'transcription' ? this.unintelligible() || !!this.transcript().trim()
      : this.intelligibility() > 0 && this.naturalness() > 0 && this.soundsLikeEdmond() !== null));
  protected readonly ratings = [1, 2, 3, 4, 5];
  protected readonly selectedRun = computed(() => this.runs().find(r => r.id === this.runId()));
  protected readonly percent = (n: number | null) => n === null ? '—' : `${(n * 100).toFixed(1)}%`;
  protected readonly score = (n: number | null) => n === null ? '—' : n.toFixed(2);

  constructor() {
    inject(DestroyRef).onDestroy(() => { this.loadVersion++; this.clearAudio(); });
    void this.loadRuns();
  }

  private clearAudio() {
    if (this.audioUrl()) URL.revokeObjectURL(this.audioUrl());
    this.audioUrl.set('');
  }

  private async loadRuns() {
    try {
      const runs = await getDocs(query(collection(db, 'runs'), orderBy('createdAt', 'desc')));
      this.runs.set(runs.docs.map(d => ({ ...d.data(), id: d.id } as TrainingRun)).filter(r => r.task === 'tts'));
      const wanted = this.route.snapshot.queryParamMap.get('run');
      const first = this.runs().find(r => r.id === wanted) ?? this.runs()[0];
      if (first) await this.openRun(first.id);
    } catch (e) { this.error.set(this.message(e)); }
    finally { this.loading.set(false); }
  }

  protected async openRun(id: string) {
    const version = ++this.loadVersion;
    this.clearAudio(); this.runId.set(id); this.index.set(null); this.answers.set({});
    this.error.set(''); this.waiting.set(false); this.showResults.set(false); this.results.set([]);
    this.loading.set(true);
    this.sessionRevealed = false;
    try {
      const prefix = `runs/${id}/`;
      // The success marker is written last, after model and sample uploads.
      const marker = JSON.parse(await (await getBlob(ref(storage, prefix + 'succeeded.json'), 64 * 1024)).text());
      if (marker.status !== 'succeeded' || marker.samples_uri !== `gs://${bucketName}/${prefix}samples/index.json`)
        throw new Error('Training exports are not complete');
      const blob = await getBlob(ref(storage, prefix + 'samples/index.json'), 2 * 1024 * 1024);
      const bytes = await blob.arrayBuffer();
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(n => n.toString(16).padStart(2, '0')).join('');
      const index = validateSampleIndex(JSON.parse(new TextDecoder().decode(bytes)), id, bucketName);
      if (marker.sample_count !== index.samples.length) throw new Error('Sample count disagrees with the completion marker');
      const uid = this.auth.user()!.uid;
      const session = doc(db, 'runs', id, 'listeningSessions', uid);
      const seed = await runTransaction(db, async tx => {
        const existing = await tx.get(session);
        if (existing.exists()) {
          const s = existing.data() as ListenSession;
          if (s.protocolVersion !== LISTEN_PROTOCOL || s.indexSha256 !== hash || s.uid !== uid || s.runId !== id)
            throw new Error('This session belongs to a different sample version');
          if (version === this.loadVersion) this.sessionRevealed = !!s.revealedAt;
          return s.seed as number;
        }
        const seed = crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;
        tx.set(session, { uid, runId: id, protocolVersion: LISTEN_PROTOCOL, indexSha256: hash, seed, createdAt: serverTimestamp() });
        return seed;
      });
      const saved = await getDocs(collection(session, 'responses'));
      if (version !== this.loadVersion) return;
      this.indexHash = hash; this.seed.set(seed); this.index.set(index);
      this.answers.set(Object.fromEntries(saved.docs.map(d => [d.id, d.data() as ListenResponse])));
      // Reconcile the manual registry only after the complete export is verified.
      if (this.auth.isAdmin() && this.selectedRun()?.status === 'running') {
        await updateDoc(doc(db, 'runs', id), { status: 'succeeded', updatedAt: serverTimestamp() });
        this.runs.update(runs => runs.map(r => r.id === id ? { ...r, status: 'succeeded' } : r));
      }
      if (this.sessionRevealed) await this.loadResults();
      else await this.loadAudio(version);
    } catch (e) {
      if (version !== this.loadVersion) return;
      const code = (e as { code?: string }).code;
      if (code === 'storage/object-not-found') this.waiting.set(true);
      else this.error.set(this.message(e));
    } finally { if (version === this.loadVersion) this.loading.set(false); }
  }

  protected async retryAudio() { await this.loadAudio(this.loadVersion); }

  private async loadAudio(version: number) {
    this.clearAudio(); this.heard.set(false); this.intelligibility.set(0); this.naturalness.set(0);
    this.soundsLikeEdmond.set(null); this.transcript.set(''); this.unintelligible.set(false);
    const trial = this.current(); if (!trial) return;
    this.audioLoading.set(true); this.error.set('');
    try {
      const blob = await getBlob(ref(storage, trial.uri), 32 * 1024 * 1024);
      if (version !== this.loadVersion || this.current()?.id !== trial.id) return;
      this.audioUrl.set(URL.createObjectURL(new Blob([blob], { type: 'audio/wav' })));
    } catch (e) { if (version === this.loadVersion) this.error.set('Could not load audio. ' + this.message(e)); }
    finally { if (version === this.loadVersion) this.audioLoading.set(false); }
  }

  protected async saveAnswer() {
    const trial = this.current(); if (!trial || !this.canSave() || this.sessionRevealed) return;
    this.saving.set(true); this.error.set('');
    const uid = this.auth.user()!.uid;
    const answer: ListenResponse = {
      listenerId: uid, runId: this.runId(), sampleId: trial.sample.id, variant: trial.variant,
      phase: trial.phase, heard: true,
      intelligibility: trial.phase === 'rating' ? this.intelligibility() : 0,
      naturalness: trial.phase === 'rating' ? this.naturalness() : 0,
      soundsLikeEdmond: trial.phase === 'rating' ? this.soundsLikeEdmond()! : false,
      transcript: trial.phase === 'transcription' && !this.unintelligible() ? this.transcript().trim() : '',
    };
    try {
      const response = doc(db, 'runs', this.runId(), 'listeningSessions', uid, 'responses', trial.id);
      await runTransaction(db, async tx => {
        const existing = await tx.get(response);
        if (existing.exists()) throw new Error('This answer was already saved in another tab. Reload to resume.');
        tx.set(response, { ...answer, createdAt: serverTimestamp() });
      });
      this.answers.update(a => ({ ...a, [trial.id]: answer }));
      await this.loadAudio(this.loadVersion);
    } catch (e) { this.error.set(this.message(e)); }
    finally { this.saving.set(false); }
  }

  protected async loadResults() {
    if (!this.auth.isAdmin() || !this.index()) return;
    this.clearAudio(); this.showResults.set(true); this.resultsLoading.set(true); this.error.set('');
    try {
      if (!this.sessionRevealed) {
        await updateDoc(doc(db, 'runs', this.runId(), 'listeningSessions', this.auth.user()!.uid), { revealedAt: serverTimestamp() });
        this.sessionRevealed = true;
      }
      const sessions = await getDocs(collection(db, 'runs', this.runId(), 'listeningSessions'));
      const responses = await Promise.all(sessions.docs.filter(d => (d.data() as ListenSession).indexSha256 === this.indexHash
        && (d.data() as ListenSession).protocolVersion === LISTEN_PROTOCOL).map(async session => {
        const valid = new Map(listenTrials(this.index()!, (session.data() as ListenSession).seed).map(t => [t.id, t]));
        const docs = await getDocs(collection(session.ref, 'responses'));
        return docs.docs.flatMap(doc => {
          const r = doc.data() as ListenResponse, trial = valid.get(doc.id);
          return trial && r.listenerId === session.id && r.runId === this.runId() && r.heard
            && r.sampleId === trial.sample.id && r.phase === trial.phase && r.variant === trial.variant ? [r] : [];
        });
      }));
      this.allResponses.set(responses.flat());
      this.results.set(listeningSummary(this.index()!, responses.flat()));
    } catch (e) { this.error.set(this.message(e)); }
    finally { this.resultsLoading.set(false); }
  }

  protected exportResults() {
    const blob = new Blob([JSON.stringify({ runId: this.runId(), protocolVersion: LISTEN_PROTOCOL,
      indexSha256: this.indexHash, exportedAt: new Date().toISOString(), summary: this.results(),
      responses: this.allResponses() }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = `${this.selectedRun()?.name ?? this.runId()}-listening-results.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private message(e: unknown) { return e instanceof Error ? e.message : String(e); }
}
