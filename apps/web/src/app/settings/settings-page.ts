import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import type { Settings } from '@expenses/shared';
import { AuthService } from '../auth/auth.service';
import { ForecastApi } from '../forecast/forecast.api';

interface SyncResultView {
  workbook: string;
  targetSheet: string;
  rawSheet: string;
  syncedAt: string;
}

@Component({
  selector: 'app-settings-page',
  standalone: true,
  imports: [DatePipe, ReactiveFormsModule],
  templateUrl: './settings-page.html',
  styleUrl: './settings-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPageComponent {
  private readonly api = inject(ForecastApi);
  private readonly fb = inject(FormBuilder);
  protected readonly auth = inject(AuthService);
  protected readonly settings = signal<Settings | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  protected readonly syncForm = this.fb.nonNullable.group({
    targetSheet: ['Snapshot', [Validators.required, Validators.maxLength(31)]],
    mode: this.fb.nonNullable.control<'overwrite' | 'new'>('overwrite'),
  });
  protected readonly syncing = signal(false);
  protected readonly syncResult = signal<SyncResultView | null>(null);
  protected readonly syncError = signal<string | null>(null);

  constructor() { void this.load(); }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.settings.set(await firstValueFrom(this.api.getSettings()));
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected async sync(): Promise<void> {
    if (this.syncForm.invalid || this.syncing()) return;
    this.syncing.set(true);
    this.syncError.set(null);
    this.syncResult.set(null);
    const { targetSheet, mode } = this.syncForm.getRawValue();
    try {
      const res = await firstValueFrom(this.api.syncExcel({ targetSheet, mode }));
      this.syncResult.set({
        workbook: res.workbook,
        targetSheet: res.targetSheet,
        rawSheet: res.rawSheet,
        syncedAt: res.syncedAt,
      });
    } catch (err) {
      const message =
        typeof err === 'object' && err && 'error' in err
          ? // HttpErrorResponse: error body has { error, message }
            (err as { error?: { message?: string; error?: string } }).error?.message ??
            (err as { error?: { error?: string } }).error?.error ??
            String(err)
          : err instanceof Error
            ? err.message
            : String(err);
      this.syncError.set(message);
    } finally {
      this.syncing.set(false);
    }
  }
}
