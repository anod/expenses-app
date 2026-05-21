import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type {
  Account,
  CreditCard,
  ForecastResult,
  LedgerEntry,
  RecurringTemplate,
  Settings,
  EsopCalculationResult,
} from '@expenses/shared';

export interface MutationResult<T> {
  entity: T;
  forecast: ForecastResult;
}

/** Wire shape accepted by the API for recurring templates. Mirrors the
 * zod schema in apps/api/src/forecast/schemas.ts which accepts either
 * the new discriminated `cadence` object OR the legacy flat
 * `day`/`monthEndPolicy` fields. */
export interface RecurringWriteBody {
  id?: string;
  description: string;
  amount: number;
  channel: RecurringTemplate['channel'];
  startDate: string;
  endDate?: string;
  cadence?: RecurringTemplate['cadence'];
  /** Legacy flat field — only used when `cadence` is omitted. */
  day?: number;
  /** Legacy flat field — only used when `cadence` is omitted. */
  monthEndPolicy?: 'clamp';
}

@Injectable({ providedIn: 'root' })
export class ForecastApi {
  private readonly http = inject(HttpClient);

  getForecast() { return this.http.get<ForecastResult>('/api/forecast'); }

  getAccount() { return this.http.get<Account>('/api/account'); }
  patchAccount(body: Account) {
    return this.http.patch<MutationResult<Account>>('/api/account', body);
  }

  listCards() { return this.http.get<CreditCard[]>('/api/cards'); }
  createCard(body: Omit<CreditCard, 'id'> & { id?: string }) {
    return this.http.post<MutationResult<CreditCard>>('/api/cards', body);
  }
  updateCard(id: string, body: Omit<CreditCard, 'id'>) {
    return this.http.patch<MutationResult<CreditCard>>(`/api/cards/${id}`, body);
  }
  deleteCard(id: string) {
    return this.http.delete<{ forecast: ForecastResult }>(`/api/cards/${id}`);
  }

  listLedger() { return this.http.get<LedgerEntry[]>('/api/ledger'); }
  createLedger(body: Omit<LedgerEntry, 'id'> & { id?: string }) {
    return this.http.post<MutationResult<LedgerEntry>>('/api/ledger', body);
  }
  updateLedger(id: string, body: Omit<LedgerEntry, 'id'>) {
    return this.http.patch<MutationResult<LedgerEntry>>(`/api/ledger/${id}`, body);
  }
  clearLedger(id: string) {
    return this.http.post<MutationResult<LedgerEntry>>(`/api/ledger/${id}/clear`, {});
  }
  deleteLedger(id: string) {
    return this.http.delete<{ forecast: ForecastResult }>(`/api/ledger/${id}`);
  }

  listRecurring() { return this.http.get<RecurringTemplate[]>('/api/recurring'); }
  createRecurring(body: RecurringWriteBody) {
    return this.http.post<MutationResult<RecurringTemplate>>('/api/recurring', body);
  }
  updateRecurring(id: string, body: Omit<RecurringWriteBody, 'id'>) {
    return this.http.patch<MutationResult<RecurringTemplate>>(`/api/recurring/${id}`, body);
  }
  deleteRecurring(id: string) {
    return this.http.delete<{ forecast: ForecastResult }>(`/api/recurring/${id}`);
  }
  addRecurringSkip(id: string, date: string) {
    return this.http.post<MutationResult<RecurringTemplate>>(
      `/api/recurring/${id}/skips/${date}`, {},
    );
  }
  removeRecurringSkip(id: string, date: string) {
    return this.http.delete<MutationResult<RecurringTemplate>>(
      `/api/recurring/${id}/skips/${date}`,
    );
  }

  getSettings() { return this.http.get<Settings>('/api/settings'); }
  patchSettings(body: Settings) {
    return this.http.patch<MutationResult<Settings>>('/api/settings', body);
  }

  syncExcel(body: { mode: 'overwrite' | 'new'; targetSheet?: string; rawSheetName?: string }) {
    return this.http.post<{
      workbook: string;
      targetSheet: string;
      rawSheet: string;
      mode: 'overwrite' | 'new';
      anchorRows: number;
      anchorCols: number;
      rawRows: number;
      syncedAt: string;
    }>('/api/sync/excel', body);
  }

  getDemo() {
    return this.http.get<{ enabled: boolean }>('/api/demo');
  }

  setDemo(enabled: boolean) {
    return this.http.post<{ enabled: boolean }>('/api/demo', { enabled });
  }

  importExcel() {
    return this.http.post<{
      summary: {
        workbook: string;
        worksheet: string;
        monthsParsed: number;
        startDate: string;
        startBalance: number;
        cardsCreated: number;
        recurringCreated: number;
        ledgerCreated: number;
        orphanedLedger: number;
        orphanedRecurring: number;
        warnings: string[];
        skippedRows: { label: string; reason: string }[];
      };
      forecast: ForecastResult;
    }>('/api/import/excel', {});
  }

  getEsop(params?: {
    usdNisRate?: number;
    currentPriceUsd?: number;
    lockDownDays?: number;
    incomeTaxRate?: number;
    asOf?: string;
  }) {
    return this.http.get<EsopCalculationResult>('/api/esop', { params: queryParams(params) });
  }
}

function queryParams(params: Record<string, string | number | undefined> | undefined): Record<string, string> {
  if (!params) return {};
  return Object.fromEntries(
    Object.entries(params)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
}
