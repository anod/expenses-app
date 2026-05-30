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
  protected readonly error = signal<string | null>(null);

  constructor() {
    void this.load();
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

  protected async resetWorkbookDefaults(): Promise<void> {
    await this.load();
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
}

function errorMessage(err: unknown): string {
  return formatApiError(err, 'Unable to load ESOP data.');
}
