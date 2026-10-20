import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { voiceResponse, voiceText } from '../../core/voice-text';
import { Icon } from '../../ui/icon';

@Component({
  selector: 'app-voice',
  imports: [FormsModule, RouterLink, Icon],
  templateUrl: './voice.html',
  styleUrl: './voice.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Voice {
  private readonly auth = inject(AuthService);
  protected readonly text = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly audioUrl = signal('');
  protected readonly spokenText = signal('');
  protected readonly generationMs = signal(0);
  protected readonly duration = signal(0);
  protected readonly cached = signal(false);
  protected readonly elapsed = signal(0);
  protected readonly examples = [
    'Mbote baninga, lelo tozali komeka mongongo na ngai.',
    'Soki oyoki ngai malamu, loba mbote.',
    'Nakobenga yo lisusu nsima ya mosala.',
  ];
  protected readonly preview = computed(() => {
    if (!this.text().trim()) return { text: '', error: '' };
    try { return { text: voiceText(this.text()), error: '' }; }
    catch (e) { return { text: '', error: (e as Error).message }; }
  });
  private controller: AbortController | null = null;
  private destroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.controller?.abort();
      this.clearAudio();
    });
  }

  protected edit(value: string) {
    if (this.busy()) return;
    this.text.set(value); this.error.set(''); this.clearAudio();
  }

  private clearAudio() {
    if (this.audioUrl()) URL.revokeObjectURL(this.audioUrl());
    this.audioUrl.set(''); this.spokenText.set('');
  }

  protected async generate() {
    if (this.busy() || !this.preview().text) return;
    const user = this.auth.user();
    if (!user) { this.error.set('Sign in to generate speech.'); return; }
    this.clearAudio(); this.error.set(''); this.busy.set(true); this.elapsed.set(0);
    this.controller = new AbortController();
    const controller = this.controller;
    const started = Date.now();
    const interval = setInterval(() => this.elapsed.set(Math.floor((Date.now() - started) / 1000)), 1000);
    const timeout = setTimeout(() => controller.abort(), 65_000);
    try {
      const request = async (refresh: boolean) => fetch('/api/voice/synthesize', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await user.getIdToken(refresh)}` },
        body: JSON.stringify({ text: this.text() }), signal: controller.signal, cache: 'no-store',
      });
      let response = await request(false);
      if (response.status === 401) response = await request(true);
      const result = await voiceResponse(response);
      if (this.destroyed || controller.signal.aborted) return;
      if (result.text !== this.preview().text) throw new Error('The speech text changed unexpectedly. Please try again.');
      this.spokenText.set(result.text); this.generationMs.set(result.generationMs);
      this.duration.set(result.duration); this.cached.set(result.cached);
      this.audioUrl.set(URL.createObjectURL(new Blob([result.blob], { type: 'audio/wav' })));
    } catch (e) {
      if (!this.destroyed) this.error.set(controller.signal.aborted
        ? 'The voice took too long to respond. Please try again; it may have been starting up.'
        : e instanceof TypeError ? 'Could not reach the voice service. Check your connection and try again.' : (e as Error).message);
    } finally {
      clearInterval(interval); clearTimeout(timeout);
      if (!this.destroyed) this.busy.set(false);
    }
  }
}
