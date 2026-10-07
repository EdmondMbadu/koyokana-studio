import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService, authErrorMessage } from '../../core/auth.service';
import { Icon } from '../../ui/icon';

@Component({
  selector: 'app-pending',
  imports: [Icon],
  template: `
    <div class="wrap">
      <header class="top">
        <span class="orb"></span>
        <span class="name">Koyokana</span>
        <span class="spacer"></span>
        <button class="btn btn-ghost btn-sm" (click)="auth.signOut()">
          <app-icon name="logout" [size]="15" /> Sign out
        </button>
      </header>

      <main class="card panel">
        @if (auth.profileError(); as err) {
          <div class="icon-tile danger"><app-icon name="alert" [size]="22" /></div>
          <h1>We couldn’t load your account</h1>
          <p class="lead">
            The studio database didn’t respond as expected. If you just set up Firebase, make sure
            Firestore is created and the security rules are deployed.
          </p>
          <pre class="err mono">{{ err }}</pre>
          <button class="btn btn-primary" (click)="reload()"><app-icon name="refresh" [size]="15" /> Try again</button>
        } @else if (auth.isOwnerEmail() && !auth.emailVerified()) {
          <div class="icon-tile"><app-icon name="mail" [size]="22" /></div>
          <h1>Verify your email</h1>
          <p class="lead">
            You’re the workspace owner. Confirm <b>{{ auth.user()?.email }}</b> to unlock admin access —
            we sent a verification link to your inbox.
          </p>
          @if (message()) {
            <div class="form-success"><app-icon name="check" [size]="15" /> {{ message() }}</div>
          }
          @if (error()) {
            <div class="form-error"><app-icon name="alert" [size]="15" /> {{ error() }}</div>
          }
          <div class="row" style="justify-content: center; margin-top: 8px">
            <button class="btn btn-secondary" (click)="resend()" [disabled]="busy()">Resend link</button>
            <button class="btn btn-primary" (click)="checkVerified()" [disabled]="busy()">
              @if (busy()) { <span class="spinner"></span> } I’ve verified
            </button>
          </div>
        } @else if (auth.role() === 'disabled') {
          <div class="icon-tile danger"><app-icon name="lock" [size]="22" /></div>
          <h1>Access disabled</h1>
          <p class="lead">Your access to Koyokana Studio has been turned off. Contact the workspace admin if this is a mistake.</p>
        } @else {
          <div class="icon-tile"><app-icon name="clock" [size]="22" /></div>
          <h1>Waiting for approval</h1>
          <p class="lead">
            Thanks for joining, {{ auth.firstName() }}. An admin will review your account shortly —
            this page updates on its own as soon as you’re approved.
          </p>
          <div class="who">
            <span class="avatar">{{ auth.initials() }}</span>
            <div>
              <div class="who-name">{{ auth.displayName() }}</div>
              <div class="muted" style="font-size: 12.5px">{{ auth.user()?.email }}</div>
            </div>
            <span class="badge badge-amber" style="margin-left: auto"><span class="dot"></span> Pending</span>
          </div>
        }
      </main>
    </div>
  `,
  styles: `
    .wrap { min-height: 100vh; display: flex; flex-direction: column; background: var(--bg-subtle); }
    .top { display: flex; align-items: center; gap: 10px; padding: 18px 24px; }
    .name { font-weight: 650; letter-spacing: -.02em; }
    .spacer { flex: 1; }
    .panel { width: min(480px, calc(100% - 32px)); margin: 8vh auto auto; padding: 36px 32px 32px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 12px; }
    .icon-tile { width: 52px; height: 52px; border-radius: 14px; display: grid; place-items: center; background: var(--bg-muted); color: var(--text); margin-bottom: 6px; }
    .icon-tile.danger { background: var(--red-bg); color: var(--red); }
    h1 { font-size: 22px; font-weight: 600; letter-spacing: -.02em; }
    .lead { color: var(--text-2); font-size: 14.5px; line-height: 1.6; }
    .err { width: 100%; text-align: left; white-space: pre-wrap; background: var(--bg-muted); padding: 10px 12px; border-radius: 10px; color: var(--text-2); max-height: 140px; overflow: auto; margin: 0; }
    .who { width: 100%; display: flex; align-items: center; gap: 12px; margin-top: 12px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 12px; text-align: left; }
    .who-name { font-weight: 550; font-size: 13.5px; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Pending {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  protected readonly busy = signal(false);
  protected readonly message = signal('');
  protected readonly error = signal('');

  constructor() {
    effect(() => {
      if (this.auth.isMember()) this.router.navigateByUrl('/');
    });
  }

  protected reload() {
    location.reload();
  }

  protected async resend() {
    this.error.set('');
    this.busy.set(true);
    try {
      await this.auth.resendVerification();
      this.message.set('Verification email sent.');
    } catch (err) {
      this.error.set(authErrorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected async checkVerified() {
    this.error.set('');
    this.message.set('');
    this.busy.set(true);
    try {
      const ok = await this.auth.refreshVerification();
      if (!ok) this.error.set('Not verified yet — click the link in the email, then try again.');
    } catch (err) {
      this.error.set(authErrorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
