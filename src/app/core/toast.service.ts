import { Injectable, signal } from '@angular/core';

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  action?: { label: string; run: () => void };
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);
  private nextId = 1;

  show(message: string, kind: ToastKind = 'info', opts: { duration?: number; action?: Toast['action'] } = {}) {
    const id = this.nextId++;
    this.toasts.update((list) => [...list.slice(-3), { id, kind, message, action: opts.action }]);
    const duration = opts.duration ?? (kind === 'error' ? 7000 : 3500);
    if (duration > 0) setTimeout(() => this.dismiss(id), duration);
    return id;
  }

  success(message: string) {
    return this.show(message, 'success');
  }

  error(message: string, err?: unknown) {
    if (err) console.error(message, err);
    const detail = err instanceof Error ? ` — ${err.message}` : '';
    return this.show(message + detail, 'error');
  }

  dismiss(id: number) {
    this.toasts.update((list) => list.filter((t) => t.id !== id));
  }
}
