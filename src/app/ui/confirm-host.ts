import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ConfirmService } from '../core/confirm.service';

@Component({
  selector: 'app-confirm-host',
  template: `
    @if (confirm.current(); as c) {
      <div class="overlay" (click)="confirm.close(false)" (keydown.escape)="confirm.close(false)">
        <div class="dialog" role="alertdialog" aria-modal="true" (click)="$event.stopPropagation()">
          <div class="dialog-header">
            <div>
              <div class="dialog-title">{{ c.title }}</div>
              <p class="dialog-sub">{{ c.message }}</p>
            </div>
          </div>
          <div class="dialog-footer" style="border-top: 0; margin-top: 8px">
            <button class="btn btn-secondary" (click)="confirm.close(false)">Cancel</button>
            <button
              class="btn"
              [class.btn-danger]="c.danger"
              [class.btn-primary]="!c.danger"
              (click)="confirm.close(true)"
              autofocus
            >
              {{ c.confirmLabel || 'Confirm' }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
  host: { '(document:keydown.escape)': 'confirm.current() && confirm.close(false)' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfirmHost {
  protected readonly confirm = inject(ConfirmService);
}
