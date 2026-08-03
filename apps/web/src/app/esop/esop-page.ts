import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { EsopCalculationResult, EsopComputedGrant } from '@expenses/shared';
import { ForecastApi } from '../forecast/forecast.api';
import { errorMessage as formatApiError } from '../core/api-error';

@Component({
  selector: 'app-esop-page',
  standalone: true,
  imports: [RouterLink],
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

  protected unlockPassed(esop: EsopCalculationResult, id: 'may31' | 'aug31'): boolean {
    return esop.pastUnlocks.some((u) => u.id === id);
  }
}

function errorMessage(err: unknown): string {
  return formatApiError(err, 'Unable to load ESOP data.');
}
