import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import type { ForecastResult } from '@expenses/shared';
import { ForecastApi } from './forecast.api';

@Component({
  selector: 'app-forecast-home',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './forecast-home.html',
  styleUrl: './forecast-home.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ForecastHomeComponent {
  private readonly api = inject(ForecastApi);
  protected readonly forecast = signal<ForecastResult | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly loading = signal(true);

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const result = await firstValueFrom(this.api.getForecast());
      this.forecast.set(result);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected fmt(amount: number): string {
    return new Intl.NumberFormat('he-IL', {
      style: 'currency', currency: 'ILS', maximumFractionDigits: 0,
    }).format(amount);
  }
}
