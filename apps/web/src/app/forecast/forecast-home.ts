import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import type { ForecastResult, LedgerEntry, Settings, ProjectionCharge } from '@expenses/shared';
import { ForecastApi } from './forecast.api';
import { BalanceChartComponent } from './balance-chart';

interface ChargeItem {
  kind: 'charge';
  date: string;
  description: string;
  amount: number;
  channel: 'bank' | 'cc';
  cardId?: string;
  /** Set for bank-channel charges (single ledger entry). Absent for cc-bill rollups. */
  entryId?: string;
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
  imports: [BalanceChartComponent, ReactiveFormsModule],
  templateUrl: './forecast-home.html',
  styleUrl: './forecast-home.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ForecastHomeComponent {
  private readonly api = inject(ForecastApi);
  private readonly fb = inject(FormBuilder);

  protected readonly forecast = signal<ForecastResult | null>(null);
  protected readonly settings = signal<Settings | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly loading = signal(true);
  protected readonly channelFilter = signal<ChannelFilter>('all');

  /** Which snapshot is being edited: 'bank', a cardId, or null. */
  protected readonly editing = signal<string | null>(null);
  protected readonly saving = signal(false);

  protected readonly bankForm = this.fb.nonNullable.group({
    bankBalance: [0, [Validators.required]],
    asOf: ['', [Validators.required]],
  });

  protected readonly cardForm = this.fb.nonNullable.group({
    currentDebit: [0, [Validators.required, Validators.min(0)]],
    asOf: ['', [Validators.required]],
  });

  /** Snackbar for clear/undo. Holds the cleared entry so we can restore it. */
  protected readonly snackbar = signal<{
    message: string;
    entry: LedgerEntry;
  } | null>(null);
  private snackbarTimer: ReturnType<typeof setTimeout> | null = null;

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

  /** Projected bank balance at the next anchor day (10th of month). */
  protected readonly nextAnchor = computed<{ date: string; balance: number; belowThreshold: boolean } | null>(() => {
    const f = this.forecast();
    if (!f) return null;
    const anchor = f.days.find((d) => d.isAnchor);
    if (!anchor) return null;
    const threshold = this.settings()?.threshold ?? 0;
    return {
      date: anchor.date,
      balance: anchor.balance,
      belowThreshold: anchor.balance < threshold,
    };
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
      // Charges first, then anchor at the end of the day. This makes the
      // anchor row visually the "closing balance" after the day's expenses.
      for (const c of day.charges) {
        const row = this.toChargeItem(day.date, c);
        if (filter === 'all' || row.channel === filter) {
          items.push(row);
        }
      }
      if (day.isAnchor) {
        items.push({
          kind: 'anchor',
          date: day.date,
          balance: day.balance,
          belowThreshold: day.balance < threshold,
        });
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

  // ---------- Snapshot editing ----------

  protected isEditingBank(): boolean { return this.editing() === 'bank'; }
  protected isEditingCard(cardId: string): boolean { return this.editing() === cardId; }
  protected isAnyEdit(): boolean { return this.editing() !== null; }

  protected startEditBank(): void {
    const f = this.forecast();
    if (!f) return;
    this.bankForm.reset({ bankBalance: f.account.bankBalance, asOf: f.account.asOf });
    this.editing.set('bank');
  }

  protected startEditCard(cardId: string): void {
    const f = this.forecast();
    const card = f?.cards.find((c) => c.cardId === cardId);
    if (!card) return;
    this.cardForm.reset({ currentDebit: card.snapshotDebit, asOf: card.asOf });
    this.editing.set(cardId);
  }

  protected cancelEdit(): void {
    this.editing.set(null);
    this.error.set(null);
  }

  protected async saveBank(): Promise<void> {
    if (this.bankForm.invalid) { this.bankForm.markAllAsTouched(); return; }
    this.saving.set(true);
    this.error.set(null);
    try {
      const v = this.bankForm.getRawValue();
      const res = await firstValueFrom(this.api.patchAccount({
        bankBalance: v.bankBalance, asOf: v.asOf,
      }));
      this.forecast.set(res.forecast);
      this.editing.set(null);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.saving.set(false);
    }
  }

  protected async saveCard(cardId: string): Promise<void> {
    if (this.cardForm.invalid) { this.cardForm.markAllAsTouched(); return; }
    const f = this.forecast();
    const card = f?.cards.find((c) => c.cardId === cardId);
    if (!card) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const v = this.cardForm.getRawValue();
      const res = await firstValueFrom(this.api.updateCard(cardId, {
        name: card.name,
        currentDebit: v.currentDebit,
        asOf: v.asOf,
        billingDayOfMonth: card.billingDayOfMonth,
      }));
      this.forecast.set(res.forecast);
      this.editing.set(null);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.saving.set(false);
    }
  }

  // ---------- Clear / undo ----------

  protected async clearCharge(entryId: string): Promise<void> {
    if (this.isAnyEdit()) return;
    this.error.set(null);
    try {
      const res = await firstValueFrom(this.api.clearLedger(entryId));
      this.forecast.set(res.forecast);
      this.showSnackbar(`Cleared “${res.entity.description}”`, res.entity);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    }
  }

  protected async undoClear(): Promise<void> {
    const snack = this.snackbar();
    if (!snack) return;
    this.dismissSnackbar();
    const e = snack.entry;
    try {
      const body = {
        description: e.description,
        amount: e.amount,
        channel: e.channel,
        date: e.date,
        status: 'pending' as const,
        ...(e.recurringId != null ? { recurringId: e.recurringId } : {}),
        ...(e.occurrenceKey != null ? { occurrenceKey: e.occurrenceKey } : {}),
      };
      const res = await firstValueFrom(this.api.updateLedger(e.id, body));
      this.forecast.set(res.forecast);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    }
  }

  protected dismissSnackbar(): void {
    if (this.snackbarTimer) {
      clearTimeout(this.snackbarTimer);
      this.snackbarTimer = null;
    }
    this.snackbar.set(null);
  }

  private showSnackbar(message: string, entry: LedgerEntry): void {
    if (this.snackbarTimer) clearTimeout(this.snackbarTimer);
    this.snackbar.set({ message, entry });
    this.snackbarTimer = setTimeout(() => this.snackbar.set(null), 6000);
  }

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
      entryId: c.source.entryId,
    };
  }
}
