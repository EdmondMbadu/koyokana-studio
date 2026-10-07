import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { collection, doc, onSnapshot, serverTimestamp, updateDoc } from 'firebase/firestore';
import { AuthService } from '../../core/auth.service';
import { ConfirmService } from '../../core/confirm.service';
import { db } from '../../core/firebase';
import { relativeTime, shortDate } from '../../core/format';
import { ROLES, Role, UserProfile } from '../../core/models';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../ui/icon';

@Component({
  selector: 'app-team',
  imports: [FormsModule, Icon],
  templateUrl: './team.html',
  styleUrl: './team.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Team {
  protected readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);

  protected readonly users = signal<UserProfile[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal<string | null>(null);
  protected readonly search = signal('');

  protected readonly pending = computed(() => this.users().filter((u) => u.role === 'pending'));
  protected readonly others = computed(() => {
    const q = this.search().trim().toLowerCase();
    return this.users()
      .filter((u) => u.role !== 'pending')
      .filter((u) => !q || `${u.displayName} ${u.email}`.toLowerCase().includes(q));
  });
  protected readonly counts = computed(() => {
    const c: Record<string, number> = {};
    for (const u of this.users()) c[u.role] = (c[u.role] ?? 0) + 1;
    return c;
  });

  protected readonly roles = ROLES.filter((r) => r.value !== 'pending');
  protected readonly relativeTime = relativeTime;
  protected readonly shortDate = shortDate;
  protected readonly studioUrl = typeof location !== 'undefined' ? location.origin : '';

  constructor() {
    const unsub = onSnapshot(
      collection(db, 'users'),
      (snap) => {
        const list = snap.docs.map((d) => ({ ...(d.data() as UserProfile), uid: d.id }));
        list.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
        this.users.set(list);
        this.loading.set(false);
      },
      (err) => {
        this.error.set(err.message);
        this.loading.set(false);
      },
    );
    inject(DestroyRef).onDestroy(unsub);
  }

  protected roleLabel(r: Role) {
    return ROLES.find((x) => x.value === r)?.label ?? r;
  }

  protected initials(u: UserProfile) {
    return (u.displayName || u.email || '?')
      .split(/\s+/)
      .slice(0, 2)
      .map((s) => s[0]?.toUpperCase() ?? '')
      .join('');
  }

  protected async setRole(u: UserProfile, role: Role, select?: HTMLSelectElement) {
    if (u.uid === this.auth.user()?.uid || role === u.role) return;
    if (role === 'disabled' || u.role === 'admin' || role === 'admin') {
      const ok = await this.confirm.ask({
        title:
          role === 'disabled'
            ? `Disable ${u.displayName}?`
            : role === 'admin'
              ? `Make ${u.displayName} an admin?`
              : `Remove admin from ${u.displayName}?`,
        message:
          role === 'disabled'
            ? 'They will lose access immediately. Their recordings stay in the library.'
            : role === 'admin'
              ? 'Admins can edit the script, freeze datasets, manage runs and change anyone’s role.'
              : `They will become a ${this.roleLabel(role).toLowerCase()}.`,
        confirmLabel: role === 'disabled' ? 'Disable' : 'Change role',
        danger: role === 'disabled',
      });
      if (!ok) {
        if (select) select.value = u.role;
        return;
      }
    }
    this.busy.set(u.uid);
    try {
      await updateDoc(doc(db, 'users', u.uid), { role, updatedAt: serverTimestamp() });
      this.toast.success(`${u.displayName} is now ${this.roleLabel(role).toLowerCase()}`);
    } catch (err) {
      if (select) select.value = u.role;
      this.toast.error('Couldn’t change the role', err);
    } finally {
      this.busy.set(null);
    }
  }

  protected async copyLink() {
    try {
      await navigator.clipboard.writeText(this.studioUrl);
      this.toast.success('Studio link copied');
    } catch {
      this.toast.error('Clipboard unavailable');
    }
  }
}
