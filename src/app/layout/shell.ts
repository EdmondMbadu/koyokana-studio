import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Unsubscribe, collection, onSnapshot, query, where } from 'firebase/firestore';
import { filter } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from '../core/auth.service';
import { db } from '../core/firebase';
import { audioAmount } from '../core/format';
import { ROLES } from '../core/models';
import { StatsService } from '../core/stats.service';
import { UploadQueue } from '../audio/upload-queue';
import { Icon } from '../ui/icon';

interface NavItem {
  path: string;
  label: string;
  icon: string;
  exact?: boolean;
  badge?: () => number;
}

interface NavGroup {
  label: string | null;
  items: NavItem[];
  show: () => boolean;
}

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Icon],
  templateUrl: './shell.html',
  styleUrl: './shell.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.escape)': 'menuOpen.set(false); navOpen.set(false)',
    '(window:beforeunload)': 'onBeforeUnload($event)',
  },
})
export class Shell {
  protected readonly auth = inject(AuthService);
  protected readonly stats = inject(StatsService);
  protected readonly uploads = inject(UploadQueue);
  private readonly router = inject(Router);

  protected readonly navOpen = signal(false);
  protected readonly menuOpen = signal(false);
  protected readonly pendingUsers = signal(0);

  protected readonly goal = computed(() => {
    const h = this.stats.approvedSec() / 3600;
    return environment.goalsHours.find((g) => g > h) ?? environment.goalsHours.at(-1)!;
  });
  protected readonly goalPct = computed(() =>
    Math.min(100, (this.stats.approvedSec() / 3600 / this.goal()) * 100),
  );
  protected readonly approvedLabel = computed(() => {
    const a = audioAmount(this.stats.approvedSec());
    return `${a.value} ${a.unit}`;
  });
  protected readonly roleLabel = computed(
    () => ROLES.find((r) => r.value === this.auth.role())?.label ?? '',
  );

  protected readonly groups: NavGroup[] = [
    {
      label: null,
      show: () => true,
      items: [{ path: '/', label: 'Home', icon: 'home', exact: true }],
    },
    {
      label: 'Studio',
      show: () => true,
      items: [
        { path: '/record', label: 'Record', icon: 'mic' },
        ...[{ path: '/review', label: 'Review', icon: 'waves', badge: () => this.stats.pendingClips() }],
      ],
    },
    {
      label: 'Data',
      show: () => this.auth.isAdmin(),
      items: [
        { path: '/script', label: 'Script', icon: 'file' },
        { path: '/datasets', label: 'Datasets', icon: 'database' },
      ],
    },
    {
      label: 'Models',
      show: () => this.auth.isAdmin(),
      items: [{ path: '/training', label: 'Training', icon: 'cpu' }],
    },
    {
      label: 'Workspace',
      show: () => this.auth.isAdmin(),
      items: [{ path: '/team', label: 'Team', icon: 'users', badge: () => this.pendingUsers() }],
    },
  ];

  constructor() {
    this.stats.refresh(0);
    const sub = this.router.events
      .pipe(filter((e) => e instanceof NavigationEnd))
      .subscribe(() => {
        this.navOpen.set(false);
        this.menuOpen.set(false);
        this.stats.refresh();
      });

    let unsubUsers: Unsubscribe | null = null;
    effect(() => {
      unsubUsers?.();
      unsubUsers = null;
      if (!this.auth.isAdmin()) {
        this.pendingUsers.set(0);
        return;
      }
      unsubUsers = onSnapshot(
        query(collection(db, 'users'), where('role', '==', 'pending')),
        (snap) => this.pendingUsers.set(snap.size),
        () => this.pendingUsers.set(0),
      );
    });

    inject(DestroyRef).onDestroy(() => {
      sub.unsubscribe();
      unsubUsers?.();
    });
  }

  protected visibleItems(group: NavGroup): NavItem[] {
    return group.items.filter((i) => i.path !== '/review' || this.auth.isReviewer());
  }

  protected async signOut() {
    this.menuOpen.set(false);
    await this.auth.signOut();
  }

  protected onBeforeUnload(e: BeforeUnloadEvent) {
    if (this.uploads.hasUnfinished()) {
      e.preventDefault();
      e.returnValue = '';
    }
  }
}
