import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, output, signal } from '@angular/core';
import { analyzeTake } from '../../audio/qc';
import { Recorder, Take } from '../../audio/recorder';
import { toDb } from '../../audio/wav';
import { Icon } from '../../ui/icon';
import { Waveform } from '../../ui/waveform';

type Step = 'intro' | 'silence' | 'speech' | 'result';
type Grade = 'good' | 'ok' | 'bad';

interface Check {
  label: string;
  value: string;
  grade: Grade;
  advice: string;
}

const SILENCE_SECONDS = 3;
const SPEECH_SECONDS = 6;
const TEST_SENTENCE = 'Mbote! Nazali awa mpo na kosalisa yo. Niongo na yo ezali mille cinq cents francs.';

/** Two-step sound check: room noise, then a spoken sentence. Nothing is saved. */
@Component({
  selector: 'app-mic-check',
  imports: [Icon, Waveform],
  template: `
    <div class="overlay" (click)="close()">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="mc-title" (click)="$event.stopPropagation()">
        <div class="dialog-header">
          <div>
            <div class="dialog-title" id="mc-title">Sound check</div>
            <p class="dialog-sub">Measures your room and your level with <b>{{ recorder.deviceLabel() }}</b>. Nothing is saved.</p>
          </div>
          <button class="icon-btn" (click)="close()" aria-label="Close"><app-icon name="x" /></button>
        </div>

        <div class="dialog-body">
          <ol class="steps">
            <li [class.on]="step() === 'silence'" [class.done]="step() === 'speech' || step() === 'result'">1 · Silence</li>
            <li [class.on]="step() === 'speech'" [class.done]="step() === 'result'">2 · Speak</li>
            <li [class.on]="step() === 'result'">3 · Result</li>
          </ol>

          @switch (step()) {
            @case ('intro') {
              <p class="lead">Sit exactly as you will when recording. First stay silent for {{ SILENCE }} seconds, then read one sentence in your normal phone voice.</p>
              <button class="btn btn-primary btn-block btn-lg" (click)="startSilence()" [disabled]="recorder.state() !== 'ready'">
                Start sound check
              </button>
            }
            @case ('silence') {
              <div class="stage">
                <div class="count">{{ countdown() }}</div>
                <p class="lead">Stay completely silent — measuring the room…</p>
              </div>
            }
            @case ('speech') {
              <div class="stage">
                <span class="rec-dot"></span>
                <p class="sentence" lang="ln">{{ TEST }}</p>
                <p class="hint">Read it now. Stops on its own in {{ countdown() }} s.</p>
              </div>
            }
            @case ('result') {
              <div class="verdict" [class]="'verdict ' + overall()">
                <app-icon [name]="overall() === 'bad' ? 'alert' : 'check'" [size]="18" />
                <div>
                  <b>{{ overall() === 'good' ? 'Ready to record' : overall() === 'ok' ? 'Usable — small fixes recommended' : 'Fix this before recording' }}</b>
                </div>
              </div>
              <ul class="checks">
                @for (c of checks(); track c.label) {
                  <li [class]="c.grade">
                    <span class="dot"></span>
                    <span class="c-label">{{ c.label }}</span>
                    <span class="c-value tabular">{{ c.value }}</span>
                    <span class="c-advice">{{ c.advice }}</span>
                  </li>
                }
              </ul>
              @if (speech(); as t) {
                <div class="playback">
                  <button class="play-btn" (click)="wave.toggle()" [attr.aria-label]="wave.playing() ? 'Pause' : 'Play'">
                    <app-icon [name]="wave.playing() ? 'pause' : 'play'" [size]="13" />
                  </button>
                  <app-waveform #wave class="wave" [samples]="t.samples" [sampleRate]="t.sampleRate" [height]="48" />
                </div>
                <p class="hint">Listen on headphones: no echo, no hum between words, no popping on “p” and “b”.</p>
              }
            }
          }
        </div>

        <div class="dialog-footer">
          @if (step() === 'result') {
            <button class="btn btn-secondary" (click)="startSilence()">Run again</button>
            <button class="btn btn-primary" (click)="close()">Done</button>
          } @else {
            <button class="btn btn-secondary" (click)="close()">Cancel</button>
          }
        </div>
      </div>
    </div>
  `,
  styles: `
    .steps { display: flex; gap: 6px; list-style: none; padding: 0; margin: 0 0 18px; }
    .steps li { flex: 1; text-align: center; font-size: 12px; padding: 6px 0; border-radius: 999px; background: var(--bg-muted); color: var(--text-3); }
    .steps li.on { background: var(--text); color: #fff; }
    .steps li.done { background: var(--green-bg); color: var(--green); }
    .lead { color: var(--text-2); font-size: 14px; line-height: 1.55; margin-bottom: 16px; }
    .stage { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 18px 0 8px; text-align: center; }
    .count { font-size: 56px; font-weight: 600; letter-spacing: -.04em; font-variant-numeric: tabular-nums; }
    .sentence { font-size: 20px; font-weight: 500; line-height: 1.4; letter-spacing: -.01em; }
    .rec-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--red); box-shadow: 0 0 0 5px rgba(229,72,77,.15); animation: blink 1.2s ease-in-out infinite; }
    @keyframes blink { 50% { opacity: .35; } }
    .verdict { display: flex; gap: 10px; align-items: center; padding: 12px 14px; border-radius: 12px; margin-bottom: 14px; font-size: 14px; }
    .verdict.good { background: var(--green-bg); color: var(--green); }
    .verdict.ok { background: var(--amber-bg); color: var(--amber); }
    .verdict.bad { background: var(--red-bg); color: #b4232a; }
    .checks { list-style: none; margin: 0 0 14px; padding: 0; border: 1px solid var(--border); border-radius: 12px; }
    .checks li { display: grid; grid-template-columns: 10px 110px 90px 1fr; gap: 10px; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 13px; }
    .checks li:last-child { border-bottom: 0; }
    .dot { width: 8px; height: 8px; border-radius: 50%; }
    .good .dot { background: var(--green); } .ok .dot { background: #c77800; } .bad .dot { background: var(--red); }
    .c-label { font-weight: 550; } .c-value { color: var(--text-2); } .c-advice { color: var(--text-3); }
    .playback { display: flex; align-items: center; gap: 10px; }
    .wave { flex: 1; min-width: 0; }
    .play-btn { width: 32px; height: 32px; border-radius: 50%; border: 0; background: var(--primary); color: #fff; display: grid; place-items: center; cursor: pointer; padding-left: 1px; flex: none; }
    @media (max-width: 560px) { .checks li { grid-template-columns: 10px 1fr auto; } .c-advice { grid-column: 2 / -1; } }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MicCheck {
  protected readonly recorder = inject(Recorder);
  readonly closed = output<void>();

  protected readonly step = signal<Step>('intro');
  protected readonly countdown = signal(0);
  protected readonly speech = signal<Take | null>(null);
  private readonly noiseDb = signal(-120);
  private readonly peakDb = signal(-120);
  private readonly speechDb = signal(-120);
  private readonly clipped = signal(0);
  private timer: ReturnType<typeof setInterval> | null = null;
  private cancelled = false;

  protected readonly SILENCE = SILENCE_SECONDS;
  protected readonly TEST = TEST_SENTENCE;

  protected readonly checks = computed<Check[]>(() => {
    const noise = this.noiseDb();
    const peak = this.peakDb();
    const snr = this.speechDb() - noise;
    const out: Check[] = [];
    out.push(
      noise <= -60
        ? { label: 'Room noise', value: `${noise.toFixed(0)} dB`, grade: 'good', advice: 'Very quiet room.' }
        : noise <= -50
          ? { label: 'Room noise', value: `${noise.toFixed(0)} dB`, grade: 'ok', advice: 'Fine. Turning off fans or AC would help.' }
          : { label: 'Room noise', value: `${noise.toFixed(0)} dB`, grade: 'bad', advice: 'Too noisy — find the hum (AC, fridge, fan) or move rooms.' },
    );
    out.push(
      this.clipped() >= 3 || peak > -3
        ? { label: 'Loudness', value: `${peak.toFixed(0)} dB peak`, grade: 'bad', advice: 'Too hot — turn the mic gain down.' }
        : peak < -24
          ? { label: 'Loudness', value: `${peak.toFixed(0)} dB peak`, grade: 'bad', advice: 'Too quiet — turn the gain up or move closer.' }
          : peak < -18
            ? { label: 'Loudness', value: `${peak.toFixed(0)} dB peak`, grade: 'ok', advice: 'A little quiet — raise the gain slightly.' }
            : { label: 'Loudness', value: `${peak.toFixed(0)} dB peak`, grade: 'good', advice: 'Peaks in the target band.' },
    );
    out.push(
      snr >= 35
        ? { label: 'Voice vs noise', value: `${snr.toFixed(0)} dB`, grade: 'good', advice: 'Clean separation.' }
        : snr >= 25
          ? { label: 'Voice vs noise', value: `${snr.toFixed(0)} dB`, grade: 'ok', advice: 'Usable. Move a little closer to the mic.' }
          : { label: 'Voice vs noise', value: `${snr.toFixed(0)} dB`, grade: 'bad', advice: 'Noise too close to your voice level.' },
    );
    return out;
  });
  protected readonly overall = computed<Grade>(() => {
    const g = this.checks().map((c) => c.grade);
    return g.includes('bad') ? 'bad' : g.includes('ok') ? 'ok' : 'good';
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.cancelled = true;
      this.clearTimer();
      if (this.recorder.recording()) this.recorder.cancel();
    });
  }

  protected async startSilence() {
    this.cancelled = false;
    this.speech.set(null);
    this.step.set('silence');
    const take = await this.capture(SILENCE_SECONDS);
    if (!take || this.cancelled) return;
    let acc = 0;
    // skip the first 300 ms (button click / chair noise)
    const from = Math.min(take.samples.length, Math.round(take.sampleRate * 0.3));
    for (let i = from; i < take.samples.length; i++) acc += take.samples[i]! * take.samples[i]!;
    this.noiseDb.set(toDb(Math.sqrt(acc / Math.max(1, take.samples.length - from))));
    this.startSpeech();
  }

  private async startSpeech() {
    this.step.set('speech');
    const take = await this.capture(SPEECH_SECONDS);
    if (!take || this.cancelled) return;
    const qc = analyzeTake(take.samples, take.sampleRate, TEST_SENTENCE);
    this.peakDb.set(qc.peakDb);
    this.speechDb.set(qc.rmsDb);
    this.clipped.set(qc.clippedSamples);
    this.speech.set(take);
    this.step.set('result');
  }

  private capture(seconds: number): Promise<Take | null> {
    return new Promise((resolve) => {
      this.recorder.start();
      this.countdown.set(seconds);
      this.clearTimer();
      this.timer = setInterval(async () => {
        const left = this.countdown() - 1;
        this.countdown.set(Math.max(0, left));
        if (left <= 0) {
          this.clearTimer();
          resolve(this.cancelled ? null : await this.recorder.stop());
        }
      }, 1000);
    });
  }

  private clearTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  protected close() {
    this.cancelled = true;
    this.clearTimer();
    if (this.recorder.recording()) this.recorder.cancel();
    this.closed.emit();
  }
}
