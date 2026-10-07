import { Timestamp } from 'firebase/firestore';

/** 4.2 s · 3m 12s · 1h 04m */
export function formatDuration(sec: number | null | undefined): string {
  if (sec == null || !isFinite(sec)) return '—';
  if (sec === 0) return '0 s';
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)} s`;
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/** Hours with one decimal: 12.4 */
export function hours(sec: number | null | undefined, digits = 1): string {
  if (!sec) return (0).toFixed(digits);
  return (sec / 3600).toFixed(digits);
}

/** 00:12:31 clock */
export function clock(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function toDate(ts: Timestamp | Date | null | undefined): Date | null {
  if (!ts) return null;
  if (ts instanceof Date) return ts;
  return typeof ts.toDate === 'function' ? ts.toDate() : null;
}

export function relativeTime(ts: Timestamp | Date | null | undefined): string {
  const d = toDate(ts);
  if (!d) return '—';
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 45) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.round(diff / 86400)}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function shortDate(ts: Timestamp | Date | null | undefined): string {
  const d = toDate(ts);
  return d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
}

/** Local calendar day as YYYY-MM-DD. */
export function dayKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** Normalizes script text: NFC, single spaces, straight trimming. */
export function normalizeText(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Picks a readable unit for an amount of audio: 42 s · 12.5 min · 3.2 h */
export function audioAmount(sec: number | null | undefined): { value: string; unit: string } {
  const s = sec ?? 0;
  if (s < 60) return { value: String(Math.round(s)), unit: 's' };
  if (s < 3600) return { value: (s / 60).toFixed(s < 600 ? 1 : 0), unit: 'min' };
  return { value: (s / 3600).toFixed(1), unit: 'h' };
}
