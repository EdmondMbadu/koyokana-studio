import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { Settings } from './settings';

describe('Settings password setup', () => {
  async function create(hasPassword = false) {
    const passwordLinked = signal(hasPassword);
    const providerIds = signal(hasPassword ? ['google.com', 'password'] : ['google.com']);
    const auth = {
      user: signal({ email: 'owner@example.test' }),
      providerIds,
      hasPassword: passwordLinked,
      profile: signal(null),
      role: signal('admin'),
      emailVerified: signal(true),
      isAdmin: () => false,
      displayName: () => 'Owner',
      initials: () => 'O',
      addPassword: jasmine.createSpy().and.callFake(async () => {
        passwordLinked.set(true);
        providerIds.set(['google.com', 'password']);
      }),
      sendPasswordReset: jasmine.createSpy().and.resolveTo(),
    };
    await TestBed.configureTestingModule({
      imports: [Settings],
      providers: [
        provideZonelessChangeDetection(),
        { provide: AuthService, useValue: auth },
        { provide: ToastService, useValue: { success: jasmine.createSpy(), error: jasmine.createSpy() } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(Settings);
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, auth, element: fixture.nativeElement as HTMLElement };
  }

  it('offers password setup for Google-only accounts and updates linked providers after saving', async () => {
    const { fixture, auth, element } = await create();
    const password = element.querySelector<HTMLInputElement>('#account-password')!;
    const confirmation = element.querySelector<HTMLInputElement>('#account-password-confirm')!;
    expect(password).not.toBeNull();
    password.value = confirmation.value = 'emulator-only-password';
    password.dispatchEvent(new Event('input'));
    confirmation.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    element.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(auth.addPassword).toHaveBeenCalledOnceWith('emulator-only-password');
    expect(element.textContent).toContain('Google, Email & password');
    expect(element.textContent).toContain('Password added');
    expect(element.querySelector('#account-password')).toBeNull();
  });

  it('offers resetting an existing password instead of silently replacing it', async () => {
    const { element } = await create(true);
    expect(element.querySelector('#account-password')).toBeNull();
    expect(element.textContent).toContain('Email me a reset link');
  });
});
