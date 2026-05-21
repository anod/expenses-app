import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import type { EsopCalculationResult } from '@expenses/shared';
import { ForecastApi } from '../forecast/forecast.api';

@Component({
  selector: 'app-esop-page',
  standalone: true,
  imports: [ReactiveFormsModule],
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
    lockDownDays: [730, [Validators.required, Validators.min(1)]],
    incomeTaxRate: [0.55, [Validators.required, Validators.min(0), Validators.max(1)]],
    asOf: ['', [Validators.required]],
  });
  protected readonly marketForm = this.fb.nonNullable.group({
    stockSymbol: ['MNDY', [Validators.required]],
    fxSymbol: ['USDILS=X', [Validators.required]],
  });

  protected readonly totals = computed(() => this.result()?.totals ?? null);

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
        lockDownDays: result.assumptions.lockDownDays,
        incomeTaxRate: result.assumptions.incomeTaxRate,
        asOf: result.assumptions.asOf,
      });
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected async applyOverrides(): Promise<void> {
    if (this.assumptionsForm.invalid) return;
    await this.load(true);
  }

  protected async resetWorkbookDefaults(): Promise<void> {
    await this.load(false);
  }

  protected async updateMarketInputs(): Promise<void> {
    if (this.marketForm.invalid) return;
    this.marketLoading.set(true);
    this.error.set(null);
    this.marketMessage.set(null);
    try {
      const quote = await firstValueFrom(this.api.getEsopMarket(this.marketForm.getRawValue()));
      this.assumptionsForm.patchValue({
        usdNisRate: quote.usdNisRate,
        currentPriceUsd: quote.currentPriceUsd,
      });
      this.marketMessage.set(
        `Updated ${quote.stock.symbol} and ${quote.fx.symbol} from Yahoo Finance.`,
      );
      await this.load(true);
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

  private assumptionOverrides() {
    const raw = this.assumptionsForm.getRawValue();
    return {
      usdNisRate: raw.usdNisRate,
      currentPriceUsd: raw.currentPriceUsd,
      lockDownDays: raw.lockDownDays,
      incomeTaxRate: raw.incomeTaxRate,
      asOf: raw.asOf,
    };
  }
}

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'error' in err) {
    const maybe = err as { error?: { message?: unknown; error?: unknown } };
    if (typeof maybe.error?.message === 'string') return maybe.error.message;
    if (typeof maybe.error?.error === 'string') return maybe.error.error;
  }
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
