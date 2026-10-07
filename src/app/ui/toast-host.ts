import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ToastService } from '../core/toast.service';
import { Icon } from './icon';

@Component({
  selector: 'app-toast-host',
  imports: [Icon],
  template: `
    <div class="toasts" aria-live="polite">
      @for (t of toasts.toasts(); track t.id) {
        <div class="toast" [class]="'toast ' + t.kind" role="status">
          <app-icon
            [name]="t.kind === 'error' ? 'alert' : t.kind === 'success' ? 'check' : 'info'"
            [size]="16"
          />
          <span class="msg">{{ t.message }}</span>
          @if (t.action; as a) {
            <button class="action" (click)="a.run(); toasts.dismiss(t.id)">{{ a.label }}</button>
          }
          <button class="close" (click)="toasts.dismiss(t.id)" aria-label="Dismiss">
            <app-icon name="x" [size]="14" />
          </button>
        </div>
      }
    </div>
  `,
  styles: `
    .toasts {
      position: fixed; right: 20px; bottom: 20px; z-index: 200;
      display: flex; flex-direction: column; gap: 8px; align-items: flex-end;
      pointer-events: none;
    }
    .toast {
      pointer-events: auto;
      display: flex; align-items: center; gap: 10px;
      max-width: 420px; padding: 10px 10px 10px 14px;
      border-radius: 12px; background: #111; color: #fff;
      box-shadow: 0 10px 30px rgba(0,0,0,.18);
      font-size: 13.5px; animation: up .2s cubic-bezier(.2,.7,.2,1);
    }
    .toast.success app-icon { color: #5ee09a; }
    .toast.error app-icon { color: #ff8a8e; }
    .msg { flex: 1; line-height: 1.4; }
    .action {
      border: 0; background: rgba(255,255,255,.12); color: #fff; height: 26px;
      padding: 0 10px; border-radius: 999px; font-size: 12.5px; font-weight: 500; cursor: pointer;
    }
    .close { border: 0; background: transparent; color: #999; cursor: pointer; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 6px; }
    .close:hover { color: #fff; background: rgba(255,255,255,.08); }
    @keyframes up { from { opacity: 0; transform: translateY(8px); } }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToastHost {
  protected readonly toasts = inject(ToastService);
}
