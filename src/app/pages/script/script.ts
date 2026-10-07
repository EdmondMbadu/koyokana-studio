import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  QueryConstraint,
  QueryDocumentSnapshot,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
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
  writeBatch,
} from 'firebase/firestore';
import { AuthService } from '../../core/auth.service';
import { ConfirmService } from '../../core/confirm.service';
import { downloadText, parseDelimited, toCsv } from '../../core/csv';
import { db } from '../../core/firebase';
import { formatDuration, normalizeText } from '../../core/format';
import { ScriptMeta, Sentence, SentenceStatus } from '../../core/models';
import { StatsService } from '../../core/stats.service';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../ui/icon';

const PAGE = 50;
const BATCH = 400;
const SECONDS_PER_SENTENCE = 6;

interface ParsedLine {
  text: string;
  category: string;
  hasDigits: boolean;
  long: boolean;
}

@Component({
  selector: 'app-script',
  imports: [FormsModule, Icon],
  templateUrl: './script.html',
  styleUrl: './script.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Script {
  protected readonly stats = inject(StatsService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);

  // list
  protected readonly status = signal<SentenceStatus | 'all'>('all');
  protected readonly category = signal('');
  protected readonly search = signal('');
  protected readonly categories = signal<string[]>([]);
  protected readonly rows = signal<Sentence[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadingMore = signal(false);
  protected readonly hasMore = signal(false);
  protected readonly error = signal<string | null>(null);
  private cursor: QueryDocumentSnapshot | null = null;
  private token = 0;

  protected readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    return q ? this.rows().filter((r) => r.text.toLowerCase().includes(q)) : this.rows();
  });
  protected readonly recordedCount = computed(() =>
    Math.max(0, this.stats.totalSentences() - this.stats.openSentences()),
  );
  protected readonly scriptTime = computed(() =>
    formatDuration(this.stats.totalSentences() * SECONDS_PER_SENTENCE),
  );

  // import
  protected readonly importOpen = signal(false);
  protected readonly importText = signal('');
  protected readonly importCategory = signal('general');
  protected readonly importFileName = signal('');
  protected readonly importing = signal(false);
  protected readonly importProgress = signal(0);
  protected readonly parsed = computed(() => this.parse(this.importText(), this.importCategory()));

  // edit
  protected readonly editing = signal<Sentence | null>(null);
  protected readonly editText = signal('');
  protected readonly editCategory = signal('');
  protected readonly savingEdit = signal(false);
  protected readonly exporting = signal(false);

  constructor() {
    this.stats.refresh(0);
    this.loadCategories();
    this.reload();
  }

  // ───────────────────────────── list

  protected setStatus(s: SentenceStatus | 'all') {
    this.status.set(s);
    this.reload();
  }

  protected setCategory(c: string) {
    this.category.set(c);
    this.reload();
  }

  protected reload() {
    this.cursor = null;
    this.rows.set([]);
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
    const t = ++this.token;
    const c: QueryConstraint[] = [];
    if (this.status() !== 'all') c.push(where('status', '==', this.status()));
    if (this.category()) c.push(where('category', '==', this.category()));
    c.push(orderBy('seq'));
    if (this.cursor) c.push(startAfter(this.cursor));
    c.push(limit(PAGE));
    try {
      const snap = await getDocs(query(collection(db, 'sentences'), ...c));
      if (t !== this.token) return;
      this.cursor = snap.docs.at(-1) ?? this.cursor;
      this.hasMore.set(snap.docs.length === PAGE);
      this.rows.update((r) => [...r, ...snap.docs.map((d) => ({ ...(d.data() as Omit<Sentence, 'id'>), id: d.id }))]);
      this.error.set(null);
    } catch (err) {
      if (t !== this.token) return;
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      if (t === this.token) this.loading.set(false);
    }
  }

  private async loadCategories() {
    try {
      const snap = await getDoc(doc(db, 'meta', 'script'));
      this.categories.set(((snap.data() as ScriptMeta | undefined)?.categories ?? []).slice().sort());
    } catch {
      /* none yet */
    }
  }

  // ───────────────────────────── import

  protected openImport() {
    this.importText.set('');
    this.importFileName.set('');
    this.importProgress.set(0);
    this.importOpen.set(true);
  }

  protected closeImport() {
    if (this.importing()) return;
    this.importOpen.set(false);
  }

  protected async onFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      this.toast.error('That file is larger than 20 MB.');
      return;
    }
    this.importFileName.set(file.name);
    this.importText.set(await file.text());
  }

  private parse(raw: string, defaultCategory: string) {
    const cat = normalizeCategory(defaultCategory) || 'general';
    let lines: { text: string; category: string }[] = [];
    const firstLine = raw.split(/\r?\n/, 1)[0]?.toLowerCase() ?? '';
    const isTable = /(^|[,\t])"?text"?([,\t]|$)/.test(firstLine);

    if (isTable) {
      const table = parseDelimited(raw);
      const header = table[0]!.map((h) => h.trim().toLowerCase());
      const ti = header.indexOf('text');
      const ci = header.indexOf('category');
      lines = table.slice(1).map((r) => ({
        text: r[ti] ?? '',
        category: ci >= 0 && r[ci]?.trim() ? normalizeCategory(r[ci]!) : cat,
      }));
    } else {
      lines = raw.split(/\r?\n/).map((text) => ({ text, category: cat }));
    }

    const seen = new Set<string>();
    let duplicates = 0;
    let tooShort = 0;
    const out: ParsedLine[] = [];
    for (const l of lines) {
      const text = normalizeText(l.text);
      if (!text) continue;
      if (text.replace(/[^\p{L}]/gu, '').length < 2) {
        tooShort++;
        continue;
      }
      const key = text.toLowerCase();
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);
      out.push({ text, category: l.category || cat, hasDigits: /\d/.test(text), long: text.length > 250 });
    }
    return {
      lines: out,
      duplicates,
      tooShort,
      digits: out.filter((l) => l.hasDigits),
      long: out.filter((l) => l.long).length,
      categories: [...new Set(out.map((l) => l.category))],
      readTime: formatDuration(out.length * SECONDS_PER_SENTENCE),
    };
  }

  protected async runImport() {
    const p = this.parsed();
    if (!p.lines.length || this.importing()) return;
    this.importing.set(true);
    this.importProgress.set(0);
    const uid = this.auth.user()!.uid;
    const base = Date.now() * 1000;
    try {
      for (let i = 0; i < p.lines.length; i += BATCH) {
        const batch = writeBatch(db);
        p.lines.slice(i, i + BATCH).forEach((l, j) => {
          const ref = doc(collection(db, 'sentences'));
          batch.set(ref, {
            text: l.text,
            category: l.category,
            seq: base + i + j,
            status: 'open',
            recordCount: 0,
            hasDigits: l.hasDigits,
            createdAt: serverTimestamp(),
            createdBy: uid,
          });
        });
        await batch.commit();
        this.importProgress.set(Math.min(1, (i + BATCH) / p.lines.length));
      }
      await setDoc(doc(db, 'meta', 'script'), { categories: arrayUnion(...p.categories) }, { merge: true });
      this.toast.success(`Imported ${p.lines.length.toLocaleString()} sentences`);
      this.importing.set(false);
      this.importOpen.set(false);
      await this.loadCategories();
      this.stats.refresh(0);
      this.reload();
    } catch (err) {
      this.importing.set(false);
      this.toast.error('Import stopped partway', err);
      this.stats.refresh(0);
      this.reload();
    }
  }

  // ───────────────────────────── edit / delete / export

  protected openEdit(s: Sentence) {
    this.editing.set(s);
    this.editText.set(s.text);
    this.editCategory.set(s.category);
  }

  protected async saveEdit() {
    const s = this.editing();
    const text = normalizeText(this.editText());
    const category = normalizeCategory(this.editCategory()) || 'general';
    if (!s || !text) return;
    this.savingEdit.set(true);
    try {
      await updateDoc(doc(db, 'sentences', s.id), { text, category, hasDigits: /\d/.test(text) });
      if (!this.categories().includes(category)) {
        await setDoc(doc(db, 'meta', 'script'), { categories: arrayUnion(category) }, { merge: true });
        this.loadCategories();
      }
      this.rows.update((r) =>
        r.map((x) => (x.id === s.id ? { ...x, text, category, hasDigits: /\d/.test(text) } : x)),
      );
      this.editing.set(null);
      this.toast.success('Sentence updated');
    } catch (err) {
      this.toast.error('Couldn’t save', err);
    } finally {
      this.savingEdit.set(false);
    }
  }

  protected async remove(s: Sentence) {
    const ok = await this.confirm.ask({
      title: 'Delete this sentence?',
      message:
        s.recordCount > 0
          ? `It has ${s.recordCount} recording(s). The clips stay in the library; only the script entry is removed.`
          : 'It will be removed from the script.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteDoc(doc(db, 'sentences', s.id));
      this.rows.update((r) => r.filter((x) => x.id !== s.id));
      this.stats.refresh(0);
    } catch (err) {
      this.toast.error('Couldn’t delete', err);
    }
  }

  protected async exportCsv() {
    this.exporting.set(true);
    try {
      const snap = await getDocs(query(collection(db, 'sentences'), orderBy('seq')));
      const rows: (string | number)[][] = [['id', 'seq', 'text', 'category', 'status', 'recordCount']];
      snap.forEach((d) => {
        const s = d.data() as Sentence;
        rows.push([d.id, s.seq, s.text, s.category, s.status, s.recordCount]);
      });
      downloadText(`koyokana-script-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows), 'text/csv');
    } catch (err) {
      this.toast.error('Export failed', err);
    } finally {
      this.exporting.set(false);
    }
  }
}

function normalizeCategory(c: string): string {
  return c.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40);
}
