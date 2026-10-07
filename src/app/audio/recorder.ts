import { Injectable, computed, signal } from '@angular/core';
import { concatFloat32, toDb } from './wav';

const WORKLET_SRC = `
class KsRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false; this.buf = []; this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.on = true; this.buf = []; this.n = 0; }
      else if (e.data === 'stop') { this.flush(); this.on = false; this.port.postMessage({ type: 'stopped' }); }
    };
  }
  flush() {
    if (!this.n) return;
    const out = new Float32Array(this.n);
    let o = 0;
    for (const b of this.buf) { out.set(b, o); o += b.length; }
    this.port.postMessage({ type: 'data', data: out }, [out.buffer]);
    this.buf = []; this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (this.on && ch) {
      this.buf.push(ch.slice(0)); this.n += ch.length;
      if (this.n >= sampleRate / 2) this.flush();
    }
    return true;
  }
}
registerProcessor('ks-recorder', KsRecorder);
`;

const MIC_KEY = 'ks.mic';
export const MAX_TAKE_SECONDS = 60;

export type MicState = 'idle' | 'requesting' | 'ready' | 'denied' | 'unavailable' | 'error';

export interface Take {
  samples: Float32Array;
  sampleRate: number;
  duration: number;
}

/**
 * Raw microphone capture via AudioWorklet.
 * Browser processing (echo cancellation, noise suppression, auto gain) is disabled —
 * training data must be the unprocessed signal.
 */
@Injectable({ providedIn: 'root' })
export class Recorder {
  readonly state = signal<MicState>('idle');
  readonly error = signal<string | null>(null);
  readonly devices = signal<MediaDeviceInfo[]>([]);
  readonly deviceId = signal<string>(readStoredMic());
  readonly recording = signal(false);
  readonly elapsed = signal(0);
  /** Current peak level in dBFS (≈60 Hz). */
  readonly level = signal(-120);
  readonly sampleRate = signal(0);
  readonly trackSettings = signal<MediaTrackSettings | null>(null);
  readonly processingOff = computed(() => {
    const s = this.trackSettings();
    if (!s) return null;
    return s.echoCancellation !== true && s.noiseSuppression !== true && s.autoGainControl !== true;
  });
  readonly deviceLabel = computed(() => {
    const id = this.trackSettings()?.deviceId;
    return this.devices().find((d) => d.deviceId === id)?.label || 'Default microphone';
  });

  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private meterRaf = 0;
  private meterBuf: Float32Array<ArrayBuffer> | null = null;
  private chunks: Float32Array[] = [];
  private stopResolve: (() => void) | null = null;
  private startedAt = 0;
  private onDeviceChange = () => this.refreshDevices();

  get isSupported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof AudioWorkletNode !== 'undefined'
    );
  }

  /** Opens (or re-opens) the microphone. */
  async open(deviceId = this.deviceId()): Promise<void> {
    if (!this.isSupported) {
      this.state.set('unavailable');
      this.error.set('This browser does not support raw audio capture. Use a recent Chrome, Edge or Safari.');
      return;
    }
    if (this.recording()) return;
    this.teardownStream();
    this.state.set('requesting');
    this.error.set(null);

    try {
      this.stream = await this.getStream(deviceId);
      await this.ensureContext();
      try {
        this.connectGraph();
      } catch {
        // Firefox cannot connect a mic to a context running at a different rate:
        // fall back to the device's native rate.
        await this.ctx?.close().catch(() => undefined);
        this.ctx = null;
        await this.ensureContext(true);
        this.connectGraph();
      }
    } catch (err) {
      this.teardownStream();
      const name = (err as DOMException)?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        this.state.set('denied');
        this.error.set('Microphone access was blocked. Allow it in the browser’s site settings, then retry.');
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        this.state.set('unavailable');
        this.error.set('No microphone was found. Plug one in and retry.');
      } else {
        this.state.set('error');
        this.error.set((err as Error)?.message || 'Could not open the microphone.');
      }
      return;
    }

    const track = this.stream.getAudioTracks()[0]!;
    this.trackSettings.set(track.getSettings());
    track.addEventListener('ended', () => {
      if (this.recording()) this.stop().catch(() => undefined);
      this.state.set('unavailable');
      this.error.set('The microphone was disconnected.');
    });
    const actualId = track.getSettings().deviceId ?? '';
    if (deviceId && actualId === deviceId) this.storeMic(deviceId);
    await this.refreshDevices();
    navigator.mediaDevices.removeEventListener('devicechange', this.onDeviceChange);
    navigator.mediaDevices.addEventListener('devicechange', this.onDeviceChange);
    this.state.set('ready');
    this.startMeter();
  }

  async selectDevice(id: string): Promise<void> {
    this.storeMic(id);
    await this.open(id);
  }

  start(): void {
    if (!this.node || this.state() !== 'ready' || this.recording()) return;
    if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => undefined);
    this.chunks = [];
    this.node.port.postMessage('start');
    this.startedAt = performance.now();
    this.elapsed.set(0);
    this.recording.set(true);
  }

  /** Stops recording and returns the captured take. */
  async stop(): Promise<Take | null> {
    if (!this.node || !this.recording()) return null;
    const done = new Promise<void>((resolve) => (this.stopResolve = resolve));
    this.node.port.postMessage('stop');
    await Promise.race([done, new Promise((r) => setTimeout(r, 1500))]);
    this.recording.set(false);
    const samples = concatFloat32(this.chunks);
    this.chunks = [];
    const sampleRate = this.ctx?.sampleRate ?? 48000;
    if (!samples.length) return null;
    return { samples, sampleRate, duration: samples.length / sampleRate };
  }

  /** Discards an in-progress recording. */
  cancel(): void {
    if (!this.node || !this.recording()) return;
    this.node.port.postMessage('stop');
    this.recording.set(false);
    this.chunks = [];
  }

  /** Releases the microphone (turns off the browser's recording indicator). */
  close(): void {
    this.cancel();
    this.teardownStream();
    navigator.mediaDevices?.removeEventListener('devicechange', this.onDeviceChange);
    this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.node = null;
    this.state.set('idle');
    this.level.set(-120);
  }

  // ───────────────────────────── internals

  private async getStream(deviceId: string): Promise<MediaStream> {
    const base: MediaTrackConstraints = {
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48000 },
      sampleSize: { ideal: 24 },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { ...base, deviceId: { exact: deviceId } } : base,
      });
    } catch (err) {
      // The stored device may have been unplugged — fall back to the default.
      if (deviceId && (err as DOMException)?.name === 'OverconstrainedError') {
        this.storeMic('');
        return navigator.mediaDevices.getUserMedia({ audio: base });
      }
      throw err;
    }
  }

  private async ensureContext(nativeRate = false): Promise<void> {
    if (this.ctx && this.ctx.state !== 'closed') {
      await this.ctx.resume().catch(() => undefined);
      return;
    }
    try {
      this.ctx = nativeRate
        ? new AudioContext({ latencyHint: 'interactive' })
        : new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    } catch {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
    }
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    try {
      await this.ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    this.node = new AudioWorkletNode(this.ctx, 'ks-recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    this.node.port.onmessage = (e: MessageEvent<{ type: string; data?: Float32Array }>) => {
      if (e.data.type === 'data' && e.data.data) {
        this.chunks.push(e.data.data);
      } else if (e.data.type === 'stopped') {
        this.stopResolve?.();
        this.stopResolve = null;
      }
    };
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.node.connect(this.sink).connect(this.ctx.destination);
    this.sampleRate.set(this.ctx.sampleRate);
    await this.ctx.resume().catch(() => undefined);
  }

  private connectGraph(): void {
    const ctx = this.ctx!;
    this.source = ctx.createMediaStreamSource(this.stream!);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.meterBuf = new Float32Array(this.analyser.fftSize);
    this.source.connect(this.analyser);
    this.source.connect(this.node!);
  }

  private startMeter(): void {
    cancelAnimationFrame(this.meterRaf);
    let lastTick = 0;
    const tick = (t: number) => {
      this.meterRaf = requestAnimationFrame(tick);
      if (!this.analyser || !this.meterBuf) return;
      if (t - lastTick < 16) return;
      lastTick = t;
      this.analyser.getFloatTimeDomainData(this.meterBuf);
      let peak = 0;
      for (let i = 0; i < this.meterBuf.length; i++) {
        const a = Math.abs(this.meterBuf[i]!);
        if (a > peak) peak = a;
      }
      this.level.set(toDb(peak));
      if (this.recording()) {
        const secs = (performance.now() - this.startedAt) / 1000;
        this.elapsed.set(secs);
      }
    };
    this.meterRaf = requestAnimationFrame(tick);
  }

  private teardownStream(): void {
    cancelAnimationFrame(this.meterRaf);
    try {
      this.source?.disconnect();
      this.analyser?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.source = null;
    this.analyser = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.trackSettings.set(null);
  }

  private async refreshDevices(): Promise<void> {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      this.devices.set(all.filter((d) => d.kind === 'audioinput' && d.deviceId));
    } catch {
      this.devices.set([]);
    }
  }

  private storeMic(id: string) {
    this.deviceId.set(id);
    try {
      localStorage.setItem(MIC_KEY, id);
    } catch {
      /* storage unavailable */
    }
  }
}

function readStoredMic(): string {
  try {
    return localStorage.getItem(MIC_KEY) ?? '';
  } catch {
    return '';
  }
}
