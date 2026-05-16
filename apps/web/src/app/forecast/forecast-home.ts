import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { ForecastResult, Settings, ProjectionCharge } from '@expenses/shared';
import { ForecastApi } from './forecast.api';
import { BalanceChartComponent } from './balance-chart';

interface UpcomingRow {
  date: string;
  description: string;
  amount: number;
  channel: 'bank' | 'cc';
  cardId?: string;
}

type ChannelFilter = 'all' | 'bank' | 'cc';

@Component({
  selector: 'app-forecast-home',
  standalone: true,
  imports: [BalanceChartComponent],
  templateUrl: './forecast-home.html',
  styleUrl: './forecast-home.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ForecastHomeComponent {
  private readonly api = inject(ForecastApi);

  protected readonly forecast = signal<ForecastResult | null>(null);
  protected readonly settings = signal<Settings | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly loading = signal(true);
  protected readonly channelFilter = signal<ChannelFilter>('all');

  protected readonly anchors = computed(() =>
    this.forecast()?.days.filter((d) => d.isAnchor) ?? [],
  );

  protected readonly allCharges = computed<UpcomingRow[]>(() => {
    const f = this.forecast();
    if (!f) return [];
    const rows: UpcomingRow[] = [];
    for (const day of f.days) {
      for (const c of day.charges) {
        rows.push(this.toRow(day.date, c));
      }
    }
    return rows;
  });

  protected readonly visibleCharges = computed(() => {
    const filter = this.channelFilter();
    if (filter === 'all') return this.allCharges();
    return this.allCharges().filter((r) => r.channel === filter);
  });

  protected readonly statusCopy = computed(() => {
    const status = this.forecast()?.status;
    switch (status) {
      case 'breach':
        return { label: 'Action needed', subtitle: 'Balance drops below safety threshold.' };
      case 'warning':
        return { label: 'Approaching limit', subtitle: 'Minimum balance is close to the threshold.' };
      case 'safe':
        return { label: 'On track', subtitle: 'Balance stays above the safety threshold.' };
      default:
        return { label: '—', subtitle: '' };
    }
  });

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const [result, settings] = await Promise.all([
        firstValueFrom(this.api.getForecast()),
        firstValueFrom(this.api.getSettings()),
      ]);
      this.forecast.set(result);
      this.settings.set(settings);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected setFilter(f: ChannelFilter): void {
    this.channelFilter.set(f);
  }

  protected fmt(amount: number): string {
    return new Intl.NumberFormat('he-IL', {
      style: 'currency', currency: 'ILS', maximumFractionDigits: 0,
    }).format(amount);
  }

  protected fmtDate(iso: string): string {
    const d = new Date(`${iso}T00:00:00`);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  }

  protected iconFor(channel: 'bank' | 'cc'): string {
    return channel === 'bank' ? 'account_balance' : 'credit_card';
  }

  private toRow(date: string, c: ProjectionCharge): UpcomingRow {
    if (c.source.kind === 'cc-bill') {
      return {
        date,
        description: c.description,
        amount: c.amount,
        channel: 'cc',
        cardId: c.source.cardId,
      };
    }
    return {
      date,
      description: c.description,
      amount: c.amount,
      channel: 'bank',
    };
  }
}
