import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import type { EsopCalculationResult, SavingsPot, Settings } from '@expenses/shared';
import { AuthService } from '../auth/auth.service';
import { errorMessage } from '../core/api-error';
import { InfoHintComponent } from '../core/info-hint';
import { ForecastApi } from '../forecast/forecast.api';

interface BackupResultView {
  workbook: string;
  targetSheet: string;
  rawSheet: string;
  backedUpAt: string;
}

@Component({
  selector: 'app-settings-page',
  standalone: true,
  imports: [DatePipe, ReactiveFormsModule, InfoHintComponent],
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

  // --- ESOP workbook settings ----------------------------------------------
  protected readonly esopSettingsForm = this.fb.nonNullable.group({
    lockDownDays: [730, [Validators.required, Validators.min(1)]],
    incomeTaxRate: [0.55, [Validators.required, Validators.min(0), Validators.max(1)]],
  });
  protected readonly esopMarketForm = this.fb.nonNullable.group({
    esopStockSymbol: ['MSFT', [Validators.required, Validators.maxLength(64)]],
    esopFxSymbol: ['USDILS=X', [Validators.required, Validators.maxLength(64)]],
  });
  protected readonly esopSettingsLoading = signal(true);
  protected readonly esopSettingsSaving = signal(false);
  protected readonly esopSettingsSaved = signal(false);
  protected readonly esopSettingsError = signal<string | null>(null);
  protected readonly esopMarketUpdating = signal(false);
  protected readonly esopMarketMessage = signal<string | null>(null);
  protected readonly esopMarketError = signal<string | null>(null);
  protected readonly esopResult = signal<EsopCalculationResult | null>(null);

  // --- Savings pots --------------------------------------------------------
  protected readonly pots = signal<SavingsPot[]>([]);
  protected readonly potsBusy = signal(false);
  protected readonly potsError = signal<string | null>(null);
  /** `null` = the editor is closed; `''` = creating; otherwise the pot id. */
  protected readonly potEditing = signal<string | null>(null);
  protected readonly potForm = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(64)]],
    balance: [0, [Validators.required, Validators.min(0)]],
    asOf: ['', [Validators.required]],
  });

  // --- Demo mode -----------------------------------------------------------
  protected readonly demoEnabled = signal(false);
  protected readonly demoBusy = signal(false);
  protected readonly demoError = signal<string | null>(null);

  // --- Excel backup --------------------------------------------------------
  protected readonly backupForm = this.fb.nonNullable.group({
    targetSheet: ['Snapshot', [Validators.required, Validators.maxLength(31)]],
    mode: this.fb.nonNullable.control<'overwrite' | 'new'>('overwrite'),
  });
  protected readonly backingUp = signal(false);
  protected readonly backupResult = signal<BackupResultView | null>(null);
  protected readonly backupError = signal<string | null>(null);

  constructor() {
    void this.load();
    void this.loadDemo();
    void this.loadEsopSettings();
    void this.loadPots();
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
      this.esopMarketForm.reset({
        esopStockSymbol: s.esopStockSymbol ?? 'MSFT',
        esopFxSymbol: s.esopFxSymbol ?? 'USDILS=X',
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
    try {
      await firstValueFrom(this.api.patchSettings(this.settingsPayload()));
      this.prefsSaved.set(true);
      setTimeout(() => this.prefsSaved.set(false), 2500);
    } catch (err) {
      this.prefsError.set(this.errMsg(err));
    } finally {
      this.savingPrefs.set(false);
    }
  }

  protected async updateEsopMarketFromSource(): Promise<void> {
    if (this.esopMarketForm.invalid || this.esopMarketUpdating()) return;
    this.esopMarketUpdating.set(true);
    this.esopMarketError.set(null);
    this.esopMarketMessage.set(null);
    const { esopStockSymbol, esopFxSymbol } = this.esopMarketForm.getRawValue();
    try {
      await firstValueFrom(this.api.patchSettings(this.marketSettingsPayload()));
      const updated = await firstValueFrom(
        this.api.updateEsopMarket({
          stockSymbol: esopStockSymbol.trim(),
          fxSymbol: esopFxSymbol.trim(),
        }),
      );
      this.esopResult.set(updated.esop);
      this.esopMarketMessage.set(
        `Saved & updated from ${updated.stock.symbol} and ${updated.fx.symbol}.`,
      );
    } catch (err) {
      this.esopMarketError.set(this.errMsg(err));
    } finally {
      this.esopMarketUpdating.set(false);
    }
  }

  protected async loadEsopSettings(): Promise<void> {
    this.esopSettingsLoading.set(true);
    this.esopSettingsError.set(null);
    try {
      const esop = await firstValueFrom(this.api.getEsop());
      this.esopResult.set(esop);
      this.esopSettingsForm.reset({
        lockDownDays: esop.assumptions.lockDownDays,
        incomeTaxRate: esop.assumptions.incomeTaxRate,
      });
    } catch (err) {
      this.esopSettingsError.set(this.errMsg(err));
    } finally {
      this.esopSettingsLoading.set(false);
    }
  }

  protected async saveEsopSettings(): Promise<void> {
    if (this.esopSettingsForm.invalid || this.esopSettingsSaving()) return;
    this.esopSettingsSaving.set(true);
    this.esopSettingsError.set(null);
    this.esopSettingsSaved.set(false);
    const body = this.esopSettingsForm.getRawValue();
    try {
      const updated = await firstValueFrom(this.api.updateEsopSettings(body));
      this.esopResult.set(updated.esop);
      this.esopSettingsForm.reset({
        lockDownDays: updated.esop.assumptions.lockDownDays,
        incomeTaxRate: updated.esop.assumptions.incomeTaxRate,
      });
      this.esopSettingsSaved.set(true);
      setTimeout(() => this.esopSettingsSaved.set(false), 2500);
    } catch (err) {
      this.esopSettingsError.set(this.errMsg(err));
    } finally {
      this.esopSettingsSaving.set(false);
    }
  }

  protected async backup(): Promise<void> {
    if (this.backupForm.invalid || this.backingUp()) return;
    this.backingUp.set(true);
    this.backupError.set(null);
    this.backupResult.set(null);
    const { targetSheet, mode } = this.backupForm.getRawValue();
    try {
      const res = await firstValueFrom(this.api.backupExcel({ targetSheet, mode }));
      this.backupResult.set({
        workbook: res.workbook,
        targetSheet: res.targetSheet,
        rawSheet: res.rawSheet,
        backedUpAt: res.syncedAt,
      });
    } catch (err) {
      this.backupError.set(this.errMsg(err));
    } finally {
      this.backingUp.set(false);
    }
  }

  // --- Savings pots --------------------------------------------------------

  protected async loadPots(): Promise<void> {
    try {
      this.pots.set(await firstValueFrom(this.api.listPots()));
    } catch (err) {
      this.potsError.set(this.errMsg(err));
    }
  }

  protected startNewPot(): void {
    this.potsError.set(null);
    this.potForm.reset({ name: '', balance: 0, asOf: this.todayIso() });
    this.potEditing.set('');
  }

  protected startEditPot(pot: SavingsPot): void {
    this.potsError.set(null);
    this.potForm.reset({ name: pot.name, balance: pot.balance, asOf: pot.asOf });
    this.potEditing.set(pot.id);
  }

  protected cancelPot(): void {
    this.potEditing.set(null);
    this.potsError.set(null);
  }

  protected async savePot(): Promise<void> {
    const editing = this.potEditing();
    if (editing === null || this.potForm.invalid || this.potsBusy()) return;
    this.potsBusy.set(true);
    this.potsError.set(null);
    const v = this.potForm.getRawValue();
    const body = { name: v.name.trim(), balance: v.balance, asOf: v.asOf };
    try {
      if (editing === '') await firstValueFrom(this.api.createPot(body));
      else await firstValueFrom(this.api.updatePot(editing, body));
      await this.loadPots();
      this.potEditing.set(null);
    } catch (err) {
      this.potsError.set(this.errMsg(err));
    } finally {
      this.potsBusy.set(false);
    }
  }

  protected async deletePot(pot: SavingsPot): Promise<void> {
    if (this.potsBusy()) return;
    const ok = window.confirm(
      `Delete “${pot.name}”? Its contributions and any recurring transfers into it will be removed from the forecast.`,
    );
    if (!ok) return;
    this.potsBusy.set(true);
    this.potsError.set(null);
    try {
      await firstValueFrom(this.api.deletePot(pot.id));
      await this.loadPots();
      if (this.potEditing() === pot.id) this.potEditing.set(null);
    } catch (err) {
      this.potsError.set(this.errMsg(err));
    } finally {
      this.potsBusy.set(false);
    }
  }

  /** Local-time `YYYY-MM-DD` for prefilling date inputs. */
  private todayIso(): string {
    return new Date().toLocaleDateString('en-CA');
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

  protected pct(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return '—';
    return new Intl.NumberFormat('en-US', {
      style: 'percent',
      maximumFractionDigits: 1,
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

  protected ils(value: number): string {
    return new Intl.NumberFormat('he-IL', {
      style: 'currency',
      currency: 'ILS',
      maximumFractionDigits: 0,
    }).format(value);
  }

  /** Human-readable "last updated" label for a stored ISO timestamp. */
  protected updatedAt(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  private errMsg(err: unknown): string {
    return errorMessage(err);
  }

  private settingsPayload(): Settings {
    const v = this.prefsForm.getRawValue();
    const body: Settings = {
      threshold: v.threshold,
      timezone: v.timezone.trim(),
      horizonMonths: v.horizonMonths,
      currency: v.currency,
    };
    const url = v.workbookUrl.trim();
    if (url !== '') body.workbookUrl = url;
    return body;
  }

  private marketSettingsPayload(): Partial<Settings> {
    const market = this.esopMarketForm.getRawValue();
    return {
      esopStockSymbol: market.esopStockSymbol.trim(),
      esopFxSymbol: market.esopFxSymbol.trim(),
    };
  }
}
