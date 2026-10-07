import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

let sharedCtx: AudioContext | null = null;
function playbackContext(): AudioContext {
  if (!sharedCtx || sharedCtx.state === 'closed') sharedCtx = new AudioContext();
  return sharedCtx;
}

/** Only one waveform plays at a time. */
let activePlayer: Waveform | null = null;

/**
 * Bar waveform with click-to-seek playback.
 * Feed it raw samples (fresh takes) or a URL (stored clips).
 */
@Component({
  selector: 'app-waveform',
  template: `
    <div
      class="wave"
      [class.loading]="loading()"
      [style.height.px]="height()"
      (click)="seekFromEvent($event)"
      role="slider"
      tabindex="-1"
      aria-label="Playback position"
      [attr.aria-valuenow]="Math.round(progress() * 100)"
    >
      <canvas #canvas></canvas>
      @if (loading()) {
        <div class="state"><span class="spinner"></span></div>
      } @else if (failed()) {
        <div class="state muted">Waveform unavailable — playback still works</div>
      }
    </div>
  `,
  styles: `
    :host { display: block; }
    .wave { position: relative; width: 100%; cursor: pointer; }
    canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
    .state { position: absolute; inset: 0; display: grid; place-items: center; font-size: 12.5px; color: var(--text-3); }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Waveform {
  readonly samples = input<Float32Array | null>(null);
  readonly sampleRate = input<number>(48000);
  readonly src = input<string | null>(null);
  readonly height = input<number>(72);
  readonly barWidth = input<number>(3);
  readonly gap = input<number>(2);
  readonly color = input<string>('#0b0b0b');
  readonly mutedColor = input<string>('#d6d6d6');

  readonly ended = output<void>();

  readonly playing = signal(false);
  readonly progress = signal(0);
  readonly duration = signal(0);
  readonly loading = signal(false);
  readonly failed = signal(false);
  protected readonly Math = Math;

  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);

  private buffer: AudioBuffer | null = null;
  private peaks: Float32Array | null = null;
  private source: AudioBufferSourceNode | null = null;
  private fallback: HTMLAudioElement | null = null;
  private startedAt = 0;
  private offset = 0;
  private raf = 0;
  private loadToken = 0;

  constructor() {
    effect(() => {
      const s = this.samples();
      const rate = this.sampleRate();
      this.stop(true);
      if (!s) return;
      const ctx = playbackContext();
      const buf = ctx.createBuffer(1, s.length, rate);
      buf.copyToChannel(s as Float32Array<ArrayBuffer>, 0);
      this.setBuffer(buf);
    });

    effect(() => {
      const url = this.src();
      if (this.samples()) return;
      this.stop(true);
      this.buffer = null;
      this.peaks = null;
      this.failed.set(false);
      this.draw();
      if (url) this.load(url);
    });

    afterNextRender(() => {
      const ro = new ResizeObserver(() => this.draw());
      ro.observe(this.host.nativeElement);
      this.destroyRef.onDestroy(() => ro.disconnect());
      this.draw();
    });

    this.destroyRef.onDestroy(() => {
      this.stop(true);
      cancelAnimationFrame(this.raf);
      if (activePlayer === this) activePlayer = null;
    });
  }

  toggle(): void {
    this.playing() ? this.pause() : this.play();
  }

  play(from?: number): void {
    if (activePlayer && activePlayer !== this) activePlayer.pause();
    activePlayer = this;
    if (from !== undefined) this.offset = from;
    if (this.offset >= this.duration() - 0.01) this.offset = 0;

    if (this.buffer) {
      const ctx = playbackContext();
      ctx.resume().catch(() => undefined);
      this.source?.stop();
      const src = ctx.createBufferSource();
      src.buffer = this.buffer;
      src.connect(ctx.destination);
      src.onended = () => {
        if (this.source !== src) return;
        this.source = null;
        this.playing.set(false);
        this.offset = 0;
        this.progress.set(0);
        this.draw();
        this.ended.emit();
      };
      src.start(0, this.offset);
      this.source = src;
      this.startedAt = ctx.currentTime - this.offset;
    } else if (this.fallback) {
      this.fallback.currentTime = this.offset;
      this.fallback.play().catch(() => this.playing.set(false));
    } else {
      return;
    }
    this.playing.set(true);
    this.tick();
  }

  pause(): void {
    if (!this.playing()) return;
    this.offset = this.currentTime();
    this.stop(false);
  }

  seek(fraction: number): void {
    const t = Math.max(0, Math.min(1, fraction)) * this.duration();
    if (this.playing()) this.play(t);
    else {
      this.offset = t;
      this.progress.set(this.duration() ? t / this.duration() : 0);
      this.draw();
    }
  }

  protected seekFromEvent(e: MouseEvent): void {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    const t = Math.max(0, Math.min(1, frac)) * this.duration();
    this.play(t);
  }

  // ───────────────────────────── internals

  private async load(url: string): Promise<void> {
    const token = ++this.loadToken;
    this.loading.set(true);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.arrayBuffer();
      const buf = await playbackContext().decodeAudioData(data);
      if (token !== this.loadToken) return;
      this.setBuffer(buf);
    } catch (err) {
      if (token !== this.loadToken) return;
      // Most likely CORS isn't configured on the bucket — fall back to an <audio> element.
      console.warn('[waveform] decode failed, using <audio> fallback', err);
      this.failed.set(true);
      const audio = new Audio();
      audio.preload = 'metadata';
      audio.src = url;
      audio.addEventListener('loadedmetadata', () => {
        if (token === this.loadToken) this.duration.set(audio.duration || 0);
      });
      audio.addEventListener('ended', () => {
        this.playing.set(false);
        this.offset = 0;
        this.progress.set(0);
        this.ended.emit();
      });
      this.fallback = audio;
    } finally {
      if (token === this.loadToken) this.loading.set(false);
    }
  }

  private setBuffer(buf: AudioBuffer): void {
    this.fallback = null;
    this.buffer = buf;
    this.duration.set(buf.duration);
    this.offset = 0;
    this.progress.set(0);
    this.peaks = null;
    this.draw();
  }

  private currentTime(): number {
    if (this.buffer && this.source) return playbackContext().currentTime - this.startedAt;
    if (this.fallback) return this.fallback.currentTime;
    return this.offset;
  }

  private stop(reset: boolean): void {
    if (this.source) {
      const s = this.source;
      this.source = null;
      try {
        s.stop();
      } catch {
        /* not started */
      }
    }
    this.fallback?.pause();
    if (reset) {
      this.offset = 0;
      this.progress.set(0);
      this.fallback = null;
    }
    this.playing.set(false);
    cancelAnimationFrame(this.raf);
    this.draw();
  }

  private tick = () => {
    cancelAnimationFrame(this.raf);
    if (!this.playing()) return;
    const d = this.duration();
    this.progress.set(d ? Math.min(1, this.currentTime() / d) : 0);
    this.draw();
    this.raf = requestAnimationFrame(this.tick);
  };

  private computePeaks(bars: number): Float32Array {
    const data = this.buffer!.getChannelData(0);
    const out = new Float32Array(bars);
    const size = data.length / bars;
    let max = 0;
    for (let b = 0; b < bars; b++) {
      const start = Math.floor(b * size);
      const end = Math.min(data.length, Math.floor((b + 1) * size));
      let p = 0;
      for (let i = start; i < end; i++) {
        const a = Math.abs(data[i]!);
        if (a > p) p = a;
      }
      out[b] = p;
      if (p > max) max = p;
    }
    const norm = Math.max(max, 0.1);
    for (let b = 0; b < bars; b++) out[b] = out[b]! / norm;
    return out;
  }

  private draw(): void {
    const el = this.canvas()?.nativeElement;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
      this.peaks = null;
    }
    const g = el.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const bw = this.barWidth();
    const step = bw + this.gap();
    const bars = Math.max(1, Math.floor((w + this.gap()) / step));
    const mid = h / 2;

    if (!this.buffer) {
      g.fillStyle = this.mutedColor();
      for (let b = 0; b < bars; b++) roundRect(g, b * step, mid - 1, bw, 2, 1);
      return;
    }
    if (!this.peaks || this.peaks.length !== bars) this.peaks = this.computePeaks(bars);
    const played = this.progress() * bars;
    for (let b = 0; b < bars; b++) {
      const bh = Math.max(2, this.peaks[b]! * (h - 4));
      g.fillStyle = b < played ? this.color() : this.mutedColor();
      roundRect(g, b * step, mid - bh / 2, bw, bh, Math.min(bw / 2, 1.5));
    }
  }
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
  g.fill();
}
