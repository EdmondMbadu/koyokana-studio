import { ChangeDetectionStrategy, Component, computed, input, signal, effect } from '@angular/core';

const FLOOR = -60;

/** Horizontal input meter in dBFS with a target band and peak hold. */
@Component({
  selector: 'app-level-meter',
  template: `
    <div class="meter" [class.hot]="db() > -3" [class.warm]="db() > -9 && db() <= -3">
      <div class="band" [style.left.%]="pct(-18)" [style.width.%]="pct(-6) - pct(-18)"></div>
      <div class="fill" [style.width.%]="pct(db())"></div>
      <div class="hold" [style.left.%]="pct(hold())"></div>
    </div>
    <div class="scale">
      <span>-60</span><span>-36</span><span>-18</span><span>-6</span><span>0 dB</span>
    </div>
  `,
  styles: `
    :host { display: block; }
    .meter { position: relative; height: 8px; border-radius: 999px; background: var(--bg-muted); overflow: hidden; }
    .band { position: absolute; top: 0; bottom: 0; background: rgba(24,121,78,.14); }
    .fill { position: absolute; left: 0; top: 0; bottom: 0; background: var(--text); border-radius: 999px; transition: width 60ms linear; }
    .warm .fill { background: #c77800; }
    .hot .fill { background: var(--red); }
    .hold { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--text-2); }
    .scale { display: flex; justify-content: space-between; margin-top: 6px; font-size: 10.5px; color: var(--text-3); font-variant-numeric: tabular-nums; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LevelMeter {
  readonly level = input<number>(-120);
  protected readonly db = computed(() => Math.max(FLOOR, Math.min(0, this.level())));
  protected readonly hold = signal(FLOOR);
  private holdAt = 0;

  constructor() {
    effect(() => {
      const v = this.db();
      const now = performance.now();
      if (v >= this.hold() || now - this.holdAt > 1200) {
        this.hold.set(v);
        this.holdAt = now;
      }
    });
  }

  protected pct(db: number): number {
    return ((Math.max(FLOOR, Math.min(0, db)) - FLOOR) / -FLOOR) * 100;
  }
}
