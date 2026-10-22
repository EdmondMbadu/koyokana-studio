import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { VOICE_RUN } from '../../core/voice-text';
import { Voice } from './voice';

describe('voice playground interactions', () => {
  const token = jasmine.createSpy('token').and.resolveTo('test-token');
  beforeEach(async () => {
    token.calls.reset();
    await TestBed.configureTestingModule({ imports: [Voice], providers: [provideRouter([]), provideZonelessChangeDetection(),
      { provide: AuthService, useValue: { user: () => ({ getIdToken: token }) } },
    ] }).compileComponents();
  });

  it('blocks invalid input without contacting the server', () => {
    const fetch = spyOn(window, 'fetch');
    const fixture = TestBed.createComponent(Voice); fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    input.value = 'mbote 123'; input.dispatchEvent(new Event('input')); fixture.detectChanges();
    expect((fixture.nativeElement.querySelector('.generate') as HTMLButtonElement).disabled).toBeTrue();
    expect(fixture.nativeElement.textContent).toContain('Write numbers'); expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the signed-in token, plays only the current text and clears stale audio when text changes', async () => {
    const bytes = new Uint8Array(100); bytes.set([82, 73, 70, 70]); bytes.set([87, 65, 86, 69], 8);
    const fetch = spyOn(window, 'fetch').and.resolveTo(new Response(bytes, { headers: {
      'Content-Type': 'audio/wav', 'X-Voice-Run': VOICE_RUN, 'X-Voice-Text': 'mbote',
      'X-Voice-Generation-Ms': '100', 'X-Voice-Duration': '1',
      'X-Voice-Version': '2', 'X-Voice-Model': 'final', 'X-Voice-Profile': 'gentle',
      'X-Voice-Source-Run': VOICE_RUN, 'X-Voice-Training-Step': '9600',
    } }));
    const fixture = TestBed.createComponent(Voice); fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    input.value = 'Mbote!'; input.dispatchEvent(new Event('input')); fixture.detectChanges();
    const run = spyOn(fixture.componentInstance as unknown as { generate(): Promise<void> }, 'generate').and.callThrough();
    fixture.nativeElement.querySelector('.generate').click();
    await run.calls.mostRecent().returnValue; fixture.detectChanges();
    expect(token).toHaveBeenCalledWith(false);
    const options = fetch.calls.mostRecent().args[1] as RequestInit;
    expect((options.headers as Record<string, string>)['Authorization']).toBe('Bearer test-token');
    expect(JSON.parse(options.body as string)).toEqual({ text: 'Mbote!', profile: 'gentle', model: 'final' });
    expect(fixture.nativeElement.querySelector('audio')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('a[download]')).not.toBeNull();
    input.value = 'matondi'; input.dispatchEvent(new Event('input')); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('audio')).toBeNull();
  });

  it('prevents duplicate requests while generation is running', async () => {
    let finish!: (r: Response) => void;
    const fetch = spyOn(window, 'fetch').and.returnValue(new Promise(resolve => { finish = resolve; }));
    const fixture = TestBed.createComponent(Voice); fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    input.value = 'mbote'; input.dispatchEvent(new Event('input')); fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('.generate') as HTMLButtonElement;
    const run = spyOn(fixture.componentInstance as unknown as { generate(): Promise<void> }, 'generate').and.callThrough();
    button.click(); fixture.detectChanges();
    await Promise.resolve();
    expect(button.disabled).toBeTrue(); expect(input.disabled).toBeTrue();
    button.click(); expect(fetch.calls.count()).toBe(1);
    finish(new Response(JSON.stringify({ error: 'Temporarily unavailable' }), { status: 503 }));
    await run.calls.mostRecent().returnValue; fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Temporarily unavailable');
    expect(button.disabled).toBeFalse();
  });
});
