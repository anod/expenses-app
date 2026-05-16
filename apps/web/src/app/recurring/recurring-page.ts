import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { RecurringTemplate } from '@expenses/shared';
import { ForecastApi } from '../forecast/forecast.api';

@Component({
  selector: 'app-recurring-page',
  standalone: true,
  templateUrl: './recurring-page.html',
  styleUrl: './recurring-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RecurringPageComponent {
  private readonly api = inject(ForecastApi);
  protected readonly templates = signal<RecurringTemplate[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  constructor() { void this.load(); }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.templates.set(await firstValueFrom(this.api.listRecurring()));
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loading.set(false);
    }
  }
}
