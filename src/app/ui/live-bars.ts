import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  input,
  viewChild,
} from '@angular/core';

/** Scrolling bars driven by the live input level (shown while recording). */
@Component({
  selector: 'app-live-bars',
  template: '<canvas #c></canvas>',
  styles: `
    :host { display: block; position: relative; }
    canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LiveBars {
  readonly level = input<number>(-120);
  readonly active = input<boolean>(false);
  readonly color = input<string>('#0b0b0b');

  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('c');
  private readonly destroyRef = inject(DestroyRef);
  private history: number[] = [];

  constructor() {
    effect(() => {
      const db = this.level();
      const active = this.active();
      const v = Math.max(0, Math.min(1, (db + 60) / 60));
      this.history.push(active ? v : 0);
      if (this.history.length > 400) this.history.shift();
      this.draw();
    });
    afterNextRender(() => {
      const ro = new ResizeObserver(() => this.draw());
      ro.observe(this.canvas().nativeElement);
      this.destroyRef.onDestroy(() => ro.disconnect());
    });
  }

  reset() {
    this.history = [];
    this.draw();
  }

  private draw() {
    const el = this.canvas()?.nativeElement;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (el.width !== Math.round(w * dpr)) el.width = Math.round(w * dpr);
    if (el.height !== Math.round(h * dpr)) el.height = Math.round(h * dpr);
    const g = el.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const bw = 3;
    const step = 5;
    const bars = Math.floor(w / step);
    const data = this.history.slice(-bars);
    const offset = bars - data.length;
    const mid = h / 2;
    for (let i = 0; i < bars; i++) {
      const v = i >= offset ? data[i - offset]! : 0;
      const bh = Math.max(2, v * v * (h - 4));
      g.fillStyle = i >= offset && v > 0 ? this.color() : '#e2e2e2';
      g.beginPath();
      g.roundRect(i * step, mid - bh / 2, bw, bh, 1.5);
      g.fill();
    }
  }
}
