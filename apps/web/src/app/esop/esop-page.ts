import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { esopUnlockLabel, type EsopCalculationResult, type EsopComputedGrant } from '@expenses/shared';
import { ForecastApi } from '../forecast/forecast.api';
import { errorMessage as formatApiError } from '../core/api-error';
import { InfoHintComponent } from '../core/info-hint';

@Component({
  selector: 'app-esop-page',
  standalone: true,
  imports: [InfoHintComponent],
  templateUrl: './esop-page.html',
  styleUrl: './esop-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EsopPageComponent {
  private readonly api = inject(ForecastApi);

  protected readonly result = signal<EsopCalculationResult | null>(null);
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
      this.result.set(result);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.loading.set(false);
    }
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
    if (this.updating()) return;
    this.updating.set(true);
    this.error.set(null);
    this.updateMessage.set(null);
    try {
      const updated = await firstValueFrom(
        this.api.updateEsopMarket({ stockSymbol: this.stockSymbol(), fxSymbol: this.fxSymbol() }),
      );
      this.result.set(updated.esop);
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
   * One-line explainer for the price panel's market values, including when each
   * was last refreshed. Surfaced through the single info tooltip so the panel
   * stays uncluttered and mobile-friendly.
   */
  protected marketValuesHint(): string {
    const esop = this.result();
    const rate = this.updatedAt(esop?.assumptions.usdNisRateUpdatedAt) ?? 'never refreshed';
    const price = this.updatedAt(esop?.assumptions.currentPriceUsdUpdatedAt) ?? 'never refreshed';
    return (
      `USD/NIS rate and ${this.stockSymbol()} price are workbook values used for this ` +
      `calculation. Last refreshed — USD/NIS: ${rate}; ${this.stockSymbol()}: ${price}. ` +
      'Tap Update to fetch the latest from the market source.'
    );
  }
}

function errorMessage(err: unknown): string {
  return formatApiError(err, 'Unable to load ESOP data.');
}
