import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import type {
  ForecastResult,
  LedgerEntry,
  Settings,
  RecurringTemplate,
  CreditCard,
} from '@expenses/shared';
import { descriptionLabel } from '@expenses/shared';
import { ForecastApi } from './forecast.api';
import { BalanceChartComponent } from './balance-chart';
import { PeriodBalanceChartComponent } from './period-balance-chart';
import { errorMessage } from '../core/api-error';
import {
  buildCurrentPeriodDays,
  buildForecastTimeline,
  type AnchorItem,
  type BilledChargeRow,
  type ChannelFilter,
  type ChargeItem,
  type TimelineItem,
} from './forecast-timeline';

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
  imports: [BalanceChartComponent, PeriodBalanceChartComponent, ReactiveFormsModule],
  templateUrl: './forecast-home.html',
  styleUrl: './forecast-home.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ForecastHomeComponent {
  private readonly api = inject(ForecastApi);
  private readonly fb = inject(FormBuilder);

  protected readonly forecast = signal<ForecastResult | null>(null);
  protected readonly settings = signal<Settings | null>(null);
  protected readonly ledger = signal<LedgerEntry[]>([]);
  protected readonly templates = signal<RecurringTemplate[]>([]);
  protected readonly cards = signal<CreditCard[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly loading = signal(true);
  protected readonly channelFilter = signal<ChannelFilter>('all');
  /** Which chart is shown in the chart card. */
  protected readonly chartView = signal<'period' | 'projected'>('period');
  /** Set of billKeys currently expanded to show their contributing charges. */
  protected readonly expandedBills = signal<ReadonlySet<string>>(new Set());

  protected toggleBill(key: string): void {
    const cur = this.expandedBills();
    const next = new Set(cur);
    if (next.has(key)) next.delete(key); else next.add(key);
    this.expandedBills.set(next);
  }

  protected isBillExpanded(key: string): boolean {
    return this.expandedBills().has(key);
  }

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
    mode: ['credit' as 'credit' | 'debit', [Validators.required]],
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

  /** Per-card summary shown beside the chart: opening debit + the amount
   * this card will bill next, on its own billing day. Debit cards are
   * excluded — every charge already hit the bank, so there's nothing to
   * snapshot or schedule. */
  protected readonly cardSummaries = computed<CardSummary[]>(() => {
    const f = this.forecast();
    if (!f) return [];
    const debitIds = new Set(
      this.cards().filter((c) => c.mode === 'debit').map((c) => c.id),
    );
    return f.cards
      .filter((card) => !debitIds.has(card.cardId))
      .map((card) => {
        // The pipeline records outstanding *after* the billing-day reset
        // (it zeros at the start of a billing day past asOf, then writes
        // the row). So the amount that's actually about to be billed is
        // the outstanding from the day immediately preceding the next
        // isBillingDay entry. Skip the asOf row itself (idx 0) because
        // on asOf the pipeline does not reset.
        const billIdx = card.days.findIndex((d, idx) => idx > 0 && d.isBillingDay);
        const nextBillDate = billIdx > 0 ? card.days[billIdx]!.date : card.asOf;
        const nextBillAmount =
          billIdx > 0 ? card.days[billIdx - 1]!.outstanding : card.openingDebit;
        return {
          cardId: card.cardId,
          name: card.name,
          openingDebit: card.openingDebit,
          nextAnchorDate: nextBillDate,
          nextAnchorOutstanding: nextBillAmount,
          billingDay: card.billingDayOfMonth,
        };
      });
  });

  /** Charges + anchors interleaved chronologically. */
  protected readonly timeline = computed<TimelineItem[]>(() => {
    const f = this.forecast();
    if (!f) return [];
    return buildForecastTimeline({
      forecast: f,
      threshold: this.settings()?.threshold ?? 0,
      filter: this.channelFilter(),
      ledger: this.ledger(),
      templates: this.templates(),
      cards: this.cards(),
    });
  });

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const [result, settings, ledger, templates, cards] = await Promise.all([
        firstValueFrom(this.api.getForecast()),
        firstValueFrom(this.api.getSettings()),
        firstValueFrom(this.api.listLedger()),
        firstValueFrom(this.api.listRecurring()),
        firstValueFrom(this.api.listCards()),
      ]);
      this.forecast.set(result);
      this.settings.set(settings);
      this.ledger.set(ledger);
      this.templates.set(templates);
      this.cards.set(cards);
    } catch (err) {
      this.error.set(errorMessage(err, 'Unable to load the forecast.'));
    } finally {
      this.loading.set(false);
    }
  }

  protected setFilter(f: ChannelFilter): void {
    this.channelFilter.set(f);
  }

  protected setChartView(v: 'period' | 'projected'): void {
    this.chartView.set(v);
  }

  /**
   * Forecast days for the current anchor period: the already-elapsed days
   * (from the period's anchor start / snapshot date) followed by the
   * projected days through and including the next anchor day (10th). Used by
   * the day-by-day current-period balance chart.
   */
  protected readonly currentPeriodDays = computed(() => {
    const f = this.forecast();
    if (!f) return [];
    return buildCurrentPeriodDays({
      forecast: f,
      ledger: this.ledger(),
      templates: this.templates(),
      cards: this.cards(),
    });
  });

  /** Today as `YYYY-MM-DD`, derived from the forecast so it matches the
   * timezone the days are computed in and sits within the chart domain. */
  protected readonly chartToday = computed(() => this.forecast()?.days[0]?.date ?? '');

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

  /** Strip any `[source]` Excel-import prefix from a description. */
  protected displayDesc(desc: string): string {
    return descriptionLabel(desc);
  }

  protected isAnchor(i: TimelineItem): i is AnchorItem {
    return i.kind === 'anchor';
  }

  protected isCharge(i: TimelineItem): i is ChargeItem {
    return i.kind === 'charge';
  }

  protected trackTimeline = (_: number, i: TimelineItem): string =>
    i.kind === 'anchor'
      ? `a:${i.date}`
      : `c:${i.date}:${i.entryId ?? i.description}:${i.past ? 'p' : 'f'}`;

  // ---------- Snapshot editing ----------

  protected isEditingBank(): boolean { return this.editing() === 'bank'; }
  protected isEditingCard(cardId: string): boolean { return this.editing() === cardId; }
  protected isAnyEdit(): boolean { return this.editing() !== null; }

  protected startEditBank(): void {
    const f = this.forecast();
    if (!f) return;
    this.bankForm.reset({ bankBalance: f.account.bankBalance, asOf: this.todayIso() });
    this.editing.set('bank');
  }

  protected startEditCard(cardId: string): void {
    const f = this.forecast();
    const card = f?.cards.find((c) => c.cardId === cardId);
    if (!card) return;
    const full = this.cards().find((c) => c.id === cardId);
    this.cardForm.reset({
      currentDebit: card.snapshotDebit,
      asOf: this.todayIso(),
      mode: full?.mode === 'debit' ? 'debit' : 'credit',
    });
    this.editing.set(cardId);
  }

  /** Local-time `YYYY-MM-DD` for prefilling date inputs. */
  private todayIso(): string {
    return new Date().toLocaleDateString('en-CA');
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
      this.error.set(errorMessage(err));
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
        mode: v.mode,
      }));
      this.forecast.set(res.forecast);
      // Refresh the cards signal so the next edit sees the new mode.
      try {
        const cards = await firstValueFrom(this.api.listCards());
        this.cards.set(cards);
      } catch {
        // best-effort refresh; the forecast itself is authoritative
      }
      this.editing.set(null);
    } catch (err) {
      this.error.set(errorMessage(err));
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
      this.error.set(errorMessage(err));
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
      this.error.set(errorMessage(err));
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

  // ---------- Skip / unskip recurring occurrences ----------

  /**
   * Skip eligibility for an itemized cc-bill sub-row. Same logic as
   * `canSkip` but the sub-row doesn't carry the channel/cardId info
   * directly — it must be supplied from the parent bill item.
   */
  protected canSkipSub(parentCardId: string | undefined, sub: BilledChargeRow): boolean {
    if (!sub.recurringId) return false;
    if (sub.past || sub.cleared) return false;
    const f = this.forecast();
    if (!f || !parentCardId) return false;
    const asOf = f.cards.find((c) => c.cardId === parentCardId)?.asOf;
    if (!asOf) return false;
    return sub.date > asOf;
  }

  /**
   * True when the user can skip this occurrence. We require:
   * - It's tied to a recurring template (recurringId set).
   * - The occurrence is in the future relative to the relevant asOf —
   *   account.asOf for bank charges, card.asOf for cc charges.
   *   (Past occurrences represent real or in-flight bank movements; the
   *   user should use "mark as cleared" instead.)
   */
  protected canSkip(item: ChargeItem): boolean {
    if (!item.recurringId) return false;
    if (item.past || item.cleared) return false;
    const f = this.forecast();
    if (!f) return false;
    const asOf =
      item.channel === 'cc' && item.cardId
        ? f.cards.find((c) => c.cardId === item.cardId)?.asOf
        : f.account.asOf;
    if (!asOf) return false;
    return item.date > asOf;
  }

  /** True when this is a persisted skipped occurrence — show "Unskip"
   * instead. The pipeline already filters skipped occurrences from the
   * forecast so this never shows up via `forecast.days`; we keep this
   * helper for sub-row rendering where we may want to surface skipped
   * occurrences explicitly in a future iteration. */
  protected isSkipped(item: BilledChargeRow | ChargeItem): boolean {
    if (!item.recurringId) return false;
    const t = this.templates().find((x) => x.id === item.recurringId);
    return t?.skips?.includes(item.date) ?? false;
  }

  protected async skipOccurrence(recurringId: string, date: string): Promise<void> {
    if (!confirm(`Skip the occurrence on ${date}?`)) return;
    this.error.set(null);
    try {
      const res = await firstValueFrom(this.api.addRecurringSkip(recurringId, date));
      this.forecast.set(res.forecast);
      this.templates.update((arr) =>
        arr.map((t) => (t.id === recurringId ? res.entity : t)),
      );
    } catch (err) {
      // 409 SKIP_CONFLICT_CLEARED bubbles up here.
      const msg = errorMessage(err);
      this.error.set(
        msg.includes('SKIP_CONFLICT_CLEARED')
          ? 'A cleared override exists for this occurrence. Un-clear it before skipping.'
          : msg,
      );
    }
  }

  protected async unskipOccurrence(recurringId: string, date: string): Promise<void> {
    this.error.set(null);
    try {
      const res = await firstValueFrom(this.api.removeRecurringSkip(recurringId, date));
      this.forecast.set(res.forecast);
      this.templates.update((arr) =>
        arr.map((t) => (t.id === recurringId ? res.entity : t)),
      );
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

}
