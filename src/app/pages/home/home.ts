import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  collection,
  documentId,
  getDocs,
  limit,
  orderBy,
  query,
  where,
} from 'firebase/firestore';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/auth.service';
import { db } from '../../core/firebase';
import { audioAmount, dayKey, formatDuration, hours, relativeTime } from '../../core/format';
import { DailyStat, Dataset, TrainingRun } from '../../core/models';
import { StatsService } from '../../core/stats.service';
import { Icon } from '../../ui/icon';
import { RUN_STATUSES } from '../training/training';

const DAYS = 14;

interface DayBar {
  key: string;
  label: string;
  weekday: string;
  minutes: number;
  clips: number;
  isToday: boolean;
}

@Component({
  selector: 'app-home',
  imports: [RouterLink, Icon],
  templateUrl: './home.html',
  styleUrl: './home.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Home {
  protected readonly auth = inject(AuthService);
  protected readonly stats = inject(StatsService);

  protected readonly days = signal<DayBar[]>(emptyDays());
  protected readonly daysLoaded = signal(false);
  protected readonly datasets = signal<Dataset[]>([]);
  protected readonly runs = signal<TrainingRun[]>([]);
  protected readonly hover = signal<DayBar | null>(null);

  protected readonly goals = environment.goalsHours;
  protected readonly maxGoal = Math.max(...environment.goalsHours);
  protected readonly approvedH = computed(() => this.stats.approvedSec() / 3600);
  protected readonly nextGoal = computed(
    () => this.goals.find((g) => g > this.approvedH()) ?? this.maxGoal,
  );
  protected readonly toNext = computed(() => Math.max(0, this.nextGoal() - this.approvedH()));
  protected readonly approvedPct = computed(() => Math.min(100, (this.approvedH() / this.maxGoal) * 100));
  protected readonly recordedPct = computed(() =>
    Math.min(100, (this.stats.totalSec() / 3600 / this.maxGoal) * 100),
  );

  protected readonly chartMax = computed(() => {
    const max = Math.max(...this.days().map((d) => d.minutes), 0);
    if (max <= 0) return 10;
    const steps = [1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240];
    return steps.find((s) => s >= max) ?? Math.ceil(max / 60) * 60;
  });
  protected readonly weekMinutes = computed(() =>
    this.days()
      .slice(-7)
      .reduce((a, d) => a + d.minutes, 0),
  );
  protected readonly weekLabel = computed(() => {
    const a = audioAmount(this.weekMinutes() * 60);
    return `${a.value} ${a.unit}`;
  });
  protected readonly approvedAmount = computed(() => audioAmount(this.stats.approvedSec()));
  protected readonly recordedAmount = computed(() => audioAmount(this.stats.totalSec()));
  protected readonly showOnboarding = computed(
    () => this.auth.isAdmin() && this.stats.loaded() && this.stats.approvedClips() === 0,
  );
  protected readonly activeDays = computed(() => this.days().filter((d) => d.minutes > 0).length);

  protected readonly hoursFmt = hours;
  protected readonly formatDuration = formatDuration;
  protected readonly relativeTime = relativeTime;

  constructor() {
    this.stats.refresh(0);
    this.loadDays();
    if (this.auth.isAdmin()) this.loadRecent();
  }

  private async loadDays() {
    const list = emptyDays();
    try {
      const snap = await getDocs(
        query(collection(db, 'daily'), where(documentId(), '>=', list[0]!.key), orderBy(documentId())),
      );
      const map = new Map<string, DailyStat>();
      snap.forEach((d) => map.set(d.id, d.data() as DailyStat));
      for (const d of list) {
        const s = map.get(d.key);
        if (s) {
          d.minutes = Math.round((s.seconds / 60) * 10) / 10;
          d.clips = s.clips;
        }
      }
    } catch (err) {
      console.warn('[home] daily stats', err);
    }
    this.days.set(list);
    this.daysLoaded.set(true);
  }

  private async loadRecent() {
    try {
      const [ds, rs] = await Promise.all([
        getDocs(query(collection(db, 'datasets'), orderBy('createdAt', 'desc'), limit(3))),
        getDocs(query(collection(db, 'runs'), orderBy('createdAt', 'desc'), limit(4))),
      ]);
      this.datasets.set(ds.docs.map((d) => ({ ...(d.data() as Omit<Dataset, 'id'>), id: d.id })));
      this.runs.set(rs.docs.map((d) => ({ ...(d.data() as Omit<TrainingRun, 'id'>), id: d.id })));
    } catch {
      /* optional */
    }
  }

  protected amount(sec: number) {
    const a = audioAmount(sec);
    return `${a.value} ${a.unit}`;
  }

  protected barHeight(d: DayBar): number {
    return (d.minutes / this.chartMax()) * 100;
  }

  protected statusOf(s: string) {
    return RUN_STATUSES.find((x) => x.value === s) ?? RUN_STATUSES[0]!;
  }
}

function emptyDays(): DayBar[] {
  const out: DayBar[] = [];
  const today = new Date();
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    out.push({
      key: dayKey(d),
      label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      weekday: d.toLocaleDateString(undefined, { weekday: 'narrow' }),
      minutes: 0,
      clips: 0,
      isToday: i === 0,
    });
  }
  return out;
}
