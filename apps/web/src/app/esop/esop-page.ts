import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import type { EsopCalculationResult, EsopComputedGrant } from '@expenses/shared';
import { ForecastApi } from '../forecast/forecast.api';
import { errorMessage as formatApiError } from '../core/api-error';

@Component({
  selector: 'app-esop-page',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './esop-page.html',
  styleUrl: './esop-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EsopPageComponent {
  private readonly api = inject(ForecastApi);
  private readonly fb = inject(FormBuilder);

  protected readonly result = signal<EsopCalculationResult | null>(null);
  protected readonly loading = signal(true);
  protected readonly marketLoading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly marketMessage = signal<string | null>(null);

  protected readonly assumptionsForm = this.fb.nonNullable.group({
    usdNisRate: [0, [Validators.required, Validators.min(0.0001)]],
    currentPriceUsd: [0, [Validators.required, Validators.min(0)]],
  });

  constructor() {
    void this.load();
  }

  protected async load(overrides = false): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const payload = overrides ? this.assumptionOverrides() : undefined;
      const result = await firstValueFrom(this.api.getEsop(payload));
      this.result.set(result);
      this.assumptionsForm.setValue({
        usdNisRate: result.assumptions.usdNisRate,
        currentPriceUsd: result.assumptions.currentPriceUsd,
      });
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected async resetWorkbookDefaults(): Promise<void> {
    await this.load(false);
  }

  protected async updateMarketInputs(): Promise<void> {
    if (this.assumptionsForm.invalid) return;
    this.marketLoading.set(true);
    this.error.set(null);
    this.marketMessage.set(null);
    try {
      const update = await firstValueFrom(
        this.api.updateEsopMarketValues(this.assumptionOverrides()),
      );
      this.result.set(update.esop);
      this.assumptionsForm.setValue({
        usdNisRate: update.esop.assumptions.usdNisRate,
        currentPriceUsd: update.esop.assumptions.currentPriceUsd,
      });
      this.marketMessage.set('Saved ESOP market values to the workbook.');
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.marketLoading.set(false);
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

  private assumptionOverrides() {
    const raw = this.assumptionsForm.getRawValue();
    return {
      usdNisRate: raw.usdNisRate,
      currentPriceUsd: raw.currentPriceUsd,
    };
  }
}

function errorMessage(err: unknown): string {
  return formatApiError(err, 'Unable to load ESOP data.');
}
