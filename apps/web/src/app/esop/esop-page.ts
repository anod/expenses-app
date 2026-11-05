import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import {
  calculateEsop,
  esopUnlockLabel,
  type EsopCalculationResult,
  type EsopComputedGrant,
} from '@expenses/shared';
import { ForecastApi } from '../forecast/forecast.api';
import { errorMessage as formatApiError } from '../core/api-error';
import { InfoHintComponent } from '../core/info-hint';

@Component({
  selector: 'app-esop-page',
  standalone: true,
  imports: [FormsModule, InfoHintComponent],
  templateUrl: './esop-page.html',
  styleUrl: './esop-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EsopPageComponent {
  private readonly api = inject(ForecastApi);

  private readonly savedResult = signal<EsopCalculationResult | null>(null);
  protected readonly simulating = signal(false);
  protected readonly simulatedRate = signal<number | null>(null);
  protected readonly simulatedPrice = signal<number | null>(null);
  private readonly preview = computed(() => {
    const saved = this.savedResult();
    if (!saved || !this.simulating()) return { result: saved, error: null };
    const rate = this.simulatedRate();
    const price = this.simulatedPrice();
    if (
      rate == null ||
      price == null ||
      !Number.isFinite(rate) ||
      !Number.isFinite(price) ||
      rate <= 0 ||
      price <= 0
    ) {
      return {
        result: saved,
        error: 'Enter a positive exchange rate and stock price. Showing saved values until both are valid.',
      };
    }
    const simulated = calculateEsop(saved.grants, {
      ...saved.assumptions,
      usdNisRate: rate,
      currentPriceUsd: price,
    });
    const values = [
      ...Object.values(simulated.totals),
      ...Object.values(simulated.pastLockdownTotals),
      ...simulated.unblockForecasts.flatMap((forecast) => [
        forecast.sumNis,
        forecast.netNis,
        forecast.sumDeltaNis,
        forecast.netDeltaNis,
      ]),
    ];
    if (values.some((value) => value != null && !Number.isFinite(value))) {
      return { result: saved, error: 'Values are too large to calculate. Showing saved values.' };
    }
    return {
      result: { ...simulated, warnings: [...new Set([...saved.warnings, ...simulated.warnings])] },
      error: null,
    };
  });
  protected readonly result = computed(() => this.preview().result);
  protected readonly simulationError = computed(() => this.preview().error);
  protected readonly loading = signal(true);
  protected readonly updating = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly updateMessage = signal<string | null>(null);

  protected readonly stockSymbol = signal('MSFT');
  protected readonly fxSymbol = signal('USDILS=X');

  constructor() {
    void this.load();
    void this.loadSymbols();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const result = await firstValueFrom(this.api.getEsop());
      this.savedResult.set(result);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected toggleSimulation(): void {
    if (this.loading() || this.updating()) return;
    if (this.simulating()) {
      this.simulating.set(false);
      this.simulatedRate.set(null);
      this.simulatedPrice.set(null);
      return;
    }
    const saved = this.savedResult();
    if (!saved) return;
    this.simulatedRate.set(saved.assumptions.usdNisRate);
    this.simulatedPrice.set(saved.assumptions.currentPriceUsd);
    this.updateMessage.set(null);
    this.simulating.set(true);
  }

  private async loadSymbols(): Promise<void> {
    try {
      const s = await firstValueFrom(this.api.getSettings());
      if (s.esopStockSymbol) this.stockSymbol.set(s.esopStockSymbol);
      if (s.esopFxSymbol) this.fxSymbol.set(s.esopFxSymbol);
    } catch {
      // Non-fatal — fall back to default MSFT / USDILS=X symbols.
    }
  }

  /**
   * Refresh live market prices from the configured tickers, write them (and
   * their fetch timestamps) back to the workbook, and show the recalculation.
   */
  protected async refresh(): Promise<void> {
    if (this.updating() || this.simulating()) return;
    this.updating.set(true);
    this.error.set(null);
    this.updateMessage.set(null);
    try {
      const updated = await firstValueFrom(
        this.api.updateEsopMarket({ stockSymbol: this.stockSymbol(), fxSymbol: this.fxSymbol() }),
      );
      this.savedResult.set(updated.esop);
      this.updateMessage.set(`Updated from ${updated.stock.symbol} · ${updated.fx.symbol}.`);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.updating.set(false);
    }
  }

  protected nis(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return '—';
    return new Intl.NumberFormat('he-IL', {
      style: 'currency',
      currency: 'ILS',
      maximumFractionDigits: 0,
    }).format(value);
  }

  protected signedNis(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return '—';
    const formatted = this.nis(Math.abs(value));
    if (value === 0) return formatted;
    return `${value > 0 ? '+' : '-'}${formatted}`;
  }

  protected usd(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return '—';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 2,
    }).format(value);
  }

  protected pct(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return '—';
    return new Intl.NumberFormat('en-US', {
      style: 'percent',
      maximumFractionDigits: 1,
    }).format(value);
  }

  protected isLockedGrant(row: EsopComputedGrant, esop: EsopCalculationResult): boolean {
    return row.ageDays < esop.assumptions.lockDownDays;
  }

  /** Human-readable "last updated" label for a stored ISO timestamp. */
  protected updatedAt(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  /** Shares folded into a grant's current holdings from passed unlock dates. */
  protected heldExtra(row: EsopComputedGrant): number {
    return row.heldAmount - row.amount;
  }

  /**
   * True when at least one grant is still inside the lock-down period, so the
   * "excluding still-locked grants" total differs from the all-grants total and
   * is worth showing as a second figure.
   */
  protected hasLockedGrants(esop: EsopCalculationResult): boolean {
    return esop.computed.some((row) => row.ageDays < esop.assumptions.lockDownDays);
  }

  /** Distinct unlock dates (passed + forecast) as sortable, labelled columns. */
  protected unlockColumns(
    esop: EsopCalculationResult,
  ): { date: string; label: string; passed: boolean }[] {
    return [
      ...esop.pastUnlocks.map((u) => ({ date: u.date, passed: true })),
      ...esop.unblockForecasts.map((f) => ({ date: f.date, passed: false })),
    ]
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .map((c) => ({ ...c, label: esopUnlockLabel(c.date) }));
  }

  /** Shares a grant unlocks on a given date, or null when it has none then. */
  protected grantUnlockAmount(row: EsopComputedGrant, date: string): number | null {
    const match = (row.unlocks ?? []).filter((u) => u.date === date);
    return match.length === 0 ? null : match.reduce((sum, u) => sum + u.amount, 0);
  }

  /**
   * Compact "last refreshed" summary for the price panel, one line per market
   * value. Surfaced through the single info tooltip so the panel stays
   * uncluttered and mobile-friendly.
   */
  protected marketValuesHint(): string {
    const esop = this.savedResult();
    const rate = this.updatedAt(esop?.assumptions.usdNisRateUpdatedAt) ?? 'never refreshed';
    const price = this.updatedAt(esop?.assumptions.currentPriceUsdUpdatedAt) ?? 'never refreshed';
    return `Last refreshed\nUSD/NIS: ${rate}\n${this.stockSymbol()}: ${price}`;
  }
}

function errorMessage(err: unknown): string {
  return formatApiError(err, 'Unable to load ESOP data.');
}
