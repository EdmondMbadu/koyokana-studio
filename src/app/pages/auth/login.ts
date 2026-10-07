import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService, authErrorMessage } from '../../core/auth.service';
import { Icon } from '../../ui/icon';

type Mode = 'signin' | 'signup' | 'reset';

@Component({
  selector: 'app-login',
  imports: [FormsModule, Icon],
  templateUrl: './login.html',
  styleUrl: './login.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Login {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  /** ?next=/record — where to go after signing in. */
  readonly next = input<string | undefined>();

  protected readonly bars = [
    28, 46, 62, 40, 74, 88, 56, 36, 64, 92, 70, 48, 30, 54, 80, 96, 72, 44, 60, 84, 58, 38, 26, 50,
    76, 90, 66, 42, 34, 58, 82, 68, 46, 30, 22, 40,
  ];
  protected readonly mode = signal<Mode>('signin');
  protected readonly name = signal('');
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly showPassword = signal(false);
  protected readonly busy = signal<'google' | 'email' | null>(null);
  protected readonly error = signal('');
  protected readonly notice = signal('');

  protected readonly title = computed(
    () =>
      ({
        signin: 'Welcome back',
        signup: 'Create your account',
        reset: 'Reset your password',
      })[this.mode()],
  );
  protected readonly subtitle = computed(
    () =>
      ({
        signin: 'Sign in to Koyokana Studio',
        signup: 'Join the studio to record and review Lingala voice data',
        reset: 'We’ll email you a link to choose a new password',
      })[this.mode()],
  );

  protected setMode(m: Mode) {
    this.mode.set(m);
    this.error.set('');
    this.notice.set('');
  }

  protected async google() {
    if (this.busy()) return;
    this.error.set('');
    this.busy.set('google');
    try {
      await this.auth.signInWithGoogle();
      await this.go();
    } catch (err) {
      this.error.set(authErrorMessage(err));
    } finally {
      this.busy.set(null);
    }
  }

  protected async submit(e: Event) {
    e.preventDefault();
    if (this.busy()) return;
    this.error.set('');
    this.notice.set('');
    const email = this.email().trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      this.error.set('Enter a valid email address.');
      return;
    }

    if (this.mode() === 'reset') {
      this.busy.set('email');
      try {
        await this.auth.sendPasswordReset(email);
        this.notice.set(`If an account exists for ${email}, a reset link is on its way.`);
      } catch (err) {
        const msg = authErrorMessage(err);
        if ((err as { code?: string }).code === 'auth/user-not-found') {
          this.notice.set(`If an account exists for ${email}, a reset link is on its way.`);
        } else this.error.set(msg);
      } finally {
        this.busy.set(null);
      }
      return;
    }

    if (this.mode() === 'signup') {
      if (!this.name().trim()) {
        this.error.set('Enter your name.');
        return;
      }
      if (this.password().length < 8) {
        this.error.set('Use at least 8 characters for your password.');
        return;
      }
    } else if (!this.password()) {
      this.error.set('Enter your password.');
      return;
    }

    this.busy.set('email');
    try {
      if (this.mode() === 'signup') {
        await this.auth.signUpWithEmail(this.name(), email, this.password());
      } else {
        await this.auth.signInWithEmail(email, this.password());
      }
      await this.go();
    } catch (err) {
      this.error.set(authErrorMessage(err));
    } finally {
      this.busy.set(null);
    }
  }

  private async go() {
    const next = this.next();
    const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
    await this.router.navigateByUrl(this.auth.isMember() ? safeNext : '/pending');
  }
}
