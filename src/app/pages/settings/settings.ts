import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { environment } from '../../../environments/environment';
import { AuthService, authErrorMessage } from '../../core/auth.service';
import { bucketName } from '../../core/firebase';
import { ROLES, SpeakerProfile } from '../../core/models';
import { ToastService } from '../../core/toast.service';
import { passwordProblem } from '../../core/password';
import { Icon } from '../../ui/icon';

@Component({
  selector: 'app-settings',
  imports: [FormsModule, Icon],
  templateUrl: './settings.html',
  styleUrl: './settings.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Settings {
  protected readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

  protected readonly displayName = signal('');
  protected readonly speaker = signal<SpeakerProfile>({
    name: '',
    gender: '',
    ageRange: '',
    region: '',
    languages: '',
  });
  protected readonly saving = signal(false);
  protected readonly sendingReset = signal(false);
  protected readonly password = signal('');
  protected readonly confirmPassword = signal('');
  protected readonly addingPassword = signal(false);
  protected readonly passwordError = signal('');
  protected readonly passwordNotice = signal('');
  private loadedFor: string | null = null;

  protected readonly providers = computed(
    () => this.auth.providerIds().map((p) => (p === 'google.com' ? 'Google' : 'Email & password')),
  );
  protected readonly hasPassword = computed(
    () => this.auth.hasPassword(),
  );
  protected readonly roleInfo = computed(() => ROLES.find((r) => r.value === this.auth.role()));
  protected readonly dirty = computed(() => {
    const p = this.auth.profile();
    if (!p) return false;
    const s = p.speaker;
    const cur = this.speaker();
    return (
      this.displayName().trim() !== p.displayName ||
      cur.name.trim() !== (s?.name ?? '') ||
      cur.gender !== (s?.gender ?? '') ||
      cur.ageRange !== (s?.ageRange ?? '') ||
      cur.region.trim() !== (s?.region ?? '') ||
      cur.languages.trim() !== (s?.languages ?? '')
    );
  });

  protected readonly workspace = {
    project: environment.firebase.projectId,
    bucket: bucketName,
    region: environment.gcp.region,
  };

  constructor() {
    effect(() => {
      const p = this.auth.profile();
      if (!p || this.loadedFor === p.uid) return;
      this.loadedFor = p.uid;
      this.displayName.set(p.displayName ?? '');
      this.speaker.set({
        name: p.speaker?.name ?? p.displayName ?? '',
        gender: p.speaker?.gender ?? '',
        ageRange: p.speaker?.ageRange ?? '',
        region: p.speaker?.region ?? '',
        languages: p.speaker?.languages ?? '',
      });
    });
  }

  protected setSpeaker<K extends keyof SpeakerProfile>(key: K, value: SpeakerProfile[K]) {
    this.speaker.update((s) => ({ ...s, [key]: value }));
  }

  protected async save() {
    const name = this.displayName().trim();
    if (!name) {
      this.toast.error('Your name can’t be empty.');
      return;
    }
    const s = this.speaker();
    this.saving.set(true);
    try {
      await this.auth.updateMyProfile({
        displayName: name,
        speaker: {
          name: s.name.trim() || name,
          gender: s.gender,
          ageRange: s.ageRange,
          region: s.region.trim(),
          languages: s.languages.trim(),
        },
      });
      this.toast.success('Settings saved');
    } catch (err) {
      this.toast.error('Couldn’t save settings', err);
    } finally {
      this.saving.set(false);
    }
  }

  protected async resetPassword() {
    const email = this.auth.user()?.email;
    if (!email) return;
    this.sendingReset.set(true);
    try {
      await this.auth.sendPasswordReset(email);
      this.toast.success(`Password reset link sent to ${email}`);
    } catch (err) {
      this.toast.error(authErrorMessage(err));
    } finally {
      this.sendingReset.set(false);
    }
  }

  protected async addPassword(event: Event) {
    event.preventDefault();
    if (this.addingPassword()) return;
    this.passwordError.set('');
    this.passwordNotice.set('');
    const problem = passwordProblem(this.password(), this.confirmPassword());
    if (problem) {
      this.passwordError.set(problem);
      return;
    }
    this.addingPassword.set(true);
    try {
      await this.auth.addPassword(this.password());
      this.passwordNotice.set('Password added. You can now sign in with your email and password or with Google.');
    } catch (err) {
      this.passwordError.set(authErrorMessage(err));
    } finally {
      this.password.set('');
      this.confirmPassword.set('');
      this.addingPassword.set(false);
    }
  }
}
