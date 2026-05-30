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

interface ImportResultView {
  workbook: string;
  worksheet: string;
  monthsParsed: number;
  cardsCreated: number;
  recurringCreated: number;
  ledgerCreated: number;
  orphanedLedger: number;
  orphanedRecurring: number;
  importedAt: string;
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

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  // --- Forecasting + data-source preferences (editable) -------------------
  protected readonly prefsForm = this.fb.nonNullable.group({
    threshold: this.fb.nonNullable.control(2000, [Validators.required, Validators.min(0)]),
    timezone: this.fb.nonNullable.control('Asia/Jerusalem', [Validators.required, Validators.maxLength(64)]),
    horizonMonths: this.fb.nonNullable.control(6, [Validators.required, Validators.min(1), Validators.max(24)]),
    currency: this.fb.nonNullable.control<'ILS'>('ILS', [Validators.required]),
    workbookUrl: this.fb.nonNullable.control('', [Validators.maxLength(2048)]),
  });
  protected readonly savingPrefs = signal(false);
  protected readonly prefsSaved = signal(false);
  protected readonly prefsError = signal<string | null>(null);

  // --- Demo mode -----------------------------------------------------------
  protected readonly demoEnabled = signal(false);
  protected readonly demoBusy = signal(false);
  protected readonly demoError = signal<string | null>(null);

  // --- Excel sync ----------------------------------------------------------
  protected readonly syncForm = this.fb.nonNullable.group({
    targetSheet: ['Snapshot', [Validators.required, Validators.maxLength(31)]],
    mode: this.fb.nonNullable.control<'overwrite' | 'new'>('overwrite'),
  });
  protected readonly syncing = signal(false);
  protected readonly syncResult = signal<SyncResultView | null>(null);
  protected readonly syncError = signal<string | null>(null);

  // --- Import from Excel ---------------------------------------------------
  protected readonly importing = signal(false);
  protected readonly importResult = signal<ImportResultView | null>(null);
  protected readonly importError = signal<string | null>(null);

  constructor() {
    void this.load();
    void this.loadDemo();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const s = await firstValueFrom(this.api.getSettings());
      this.prefsForm.reset({
        threshold: s.threshold,
        timezone: s.timezone,
        horizonMonths: s.horizonMonths,
        currency: s.currency,
        workbookUrl: s.workbookUrl ?? '',
      });
    } catch (err) {
      this.error.set(this.errMsg(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected async loadDemo(): Promise<void> {
    try {
      const r = await firstValueFrom(this.api.getDemo());
      this.demoEnabled.set(r.enabled);
    } catch {
      // non-fatal — older servers may not expose this endpoint
    }
  }

  protected async toggleDemo(enabled: boolean): Promise<void> {
    if (this.demoBusy()) return;
    this.demoBusy.set(true);
    this.demoError.set(null);
    try {
      const r = await firstValueFrom(this.api.setDemo(enabled));
      this.demoEnabled.set(r.enabled);
      // Force a clean reload so /api/config, auth state, header badge,
      // and all in-memory caches re-initialize against the new source.
      window.location.reload();
    } catch (err) {
      this.demoError.set(this.errMsg(err));
    } finally {
      this.demoBusy.set(false);
    }
  }

  protected async savePrefs(): Promise<void> {
    if (this.prefsForm.invalid || this.savingPrefs()) return;
    this.savingPrefs.set(true);
    this.prefsError.set(null);
    this.prefsSaved.set(false);
    const v = this.prefsForm.getRawValue();
    const body: Settings = {
      threshold: v.threshold,
      timezone: v.timezone.trim(),
      horizonMonths: v.horizonMonths,
      currency: v.currency,
    };
    const url = v.workbookUrl.trim();
    if (url !== '') body.workbookUrl = url;
    try {
      await firstValueFrom(this.api.patchSettings(body));
      this.prefsSaved.set(true);
      setTimeout(() => this.prefsSaved.set(false), 2500);
    } catch (err) {
      this.prefsError.set(this.errMsg(err));
    } finally {
      this.savingPrefs.set(false);
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
      this.syncError.set(this.errMsg(err));
    } finally {
      this.syncing.set(false);
    }
  }

  protected async runImport(): Promise<void> {
    if (this.importing()) return;
    this.importing.set(true);
    this.importError.set(null);
    this.importResult.set(null);
    try {
      const res = await firstValueFrom(this.api.importExcel());
      this.importResult.set({
        workbook: res.summary.workbook,
        worksheet: res.summary.worksheet,
        monthsParsed: res.summary.monthsParsed,
        cardsCreated: res.summary.cardsCreated,
        recurringCreated: res.summary.recurringCreated,
        ledgerCreated: res.summary.ledgerCreated,
        orphanedLedger: res.summary.orphanedLedger,
        orphanedRecurring: res.summary.orphanedRecurring,
        importedAt: new Date().toISOString(),
      });
    } catch (err) {
      this.importError.set(this.errMsg(err));
    } finally {
      this.importing.set(false);
    }
  }

  protected workbookLink(): string | null {
    const value = this.prefsForm.controls.workbookUrl.value.trim();
    if (!value) return null;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch {
      return null;
    }
  }

  private errMsg(err: unknown): string {
    if (typeof err === 'object' && err && 'error' in err) {
      const body = (err as { error?: { message?: string; error?: string } }).error;
      if (body?.message) return body.message;
      if (body?.error) return body.error;
    }
    return err instanceof Error ? err.message : String(err);
  }
}
