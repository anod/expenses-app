import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { ForecastResult, Settings, ProjectionCharge } from '@expenses/shared';
import { ForecastApi } from './forecast.api';
import { BalanceChartComponent } from './balance-chart';

interface ChargeItem {
  kind: 'charge';
  date: string;
  description: string;
  amount: number;
  channel: 'bank' | 'cc';
  cardId?: string;
}

interface AnchorItem {
  kind: 'anchor';
  date: string;
  balance: number;
  belowThreshold: boolean;
}

type TimelineItem = ChargeItem | AnchorItem;
type ChannelFilter = 'all' | 'bank' | 'cc';

interface CardSummary {
  cardId: string;
  name: string;
  openingDebit: number;
  nextAnchorDate: string;
  nextAnchorOutstanding: number;
  billingDay: number;
}

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

  /** Per-card summary shown beside the chart: opening debit + next anchor projection. */
  protected readonly cardSummaries = computed<CardSummary[]>(() => {
    const f = this.forecast();
    if (!f) return [];
    const nextAnchor = f.days.find((d) => d.isAnchor);
    return f.cards.map((card) => {
      const anchorDay = nextAnchor
        ? card.days.find((d) => d.date === nextAnchor.date)
        : undefined;
      return {
        cardId: card.cardId,
        name: card.name,
        openingDebit: card.openingDebit,
        nextAnchorDate: nextAnchor?.date ?? card.asOf,
        nextAnchorOutstanding: anchorDay?.outstanding ?? 0,
        billingDay: card.billingDayOfMonth,
      };
    });
  });

  /** Charges + anchors interleaved chronologically. Anchors render as separators. */
  protected readonly timeline = computed<TimelineItem[]>(() => {
    const f = this.forecast();
    if (!f) return [];
    const threshold = this.settings()?.threshold ?? 0;
    const filter = this.channelFilter();
    const items: TimelineItem[] = [];
    for (const day of f.days) {
      if (day.isAnchor) {
        items.push({
          kind: 'anchor',
          date: day.date,
          balance: day.balance,
          belowThreshold: day.balance < threshold,
        });
      }
      for (const c of day.charges) {
        const row = this.toChargeItem(day.date, c);
        if (filter === 'all' || row.channel === filter) {
          items.push(row);
        }
      }
    }
    return items;
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

  protected fmtAnchorDate(iso: string): string {
    const d = new Date(`${iso}T00:00:00`);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
  }

  protected iconFor(channel: 'bank' | 'cc'): string {
    return channel === 'bank' ? 'account_balance' : 'credit_card';
  }

  protected isAnchor(i: TimelineItem): i is AnchorItem {
    return i.kind === 'anchor';
  }

  protected isCharge(i: TimelineItem): i is ChargeItem {
    return i.kind === 'charge';
  }

  protected trackTimeline = (_: number, i: TimelineItem): string =>
    i.kind === 'anchor' ? `a:${i.date}` : `c:${i.date}:${i.description}`;

  private toChargeItem(date: string, c: ProjectionCharge): ChargeItem {
    if (c.source.kind === 'cc-bill') {
      return {
        kind: 'charge',
        date,
        description: c.description,
        amount: c.amount,
        channel: 'cc',
        cardId: c.source.cardId,
      };
    }
    return {
      kind: 'charge',
      date,
      description: c.description,
      amount: c.amount,
      channel: 'bank',
    };
  }
}
