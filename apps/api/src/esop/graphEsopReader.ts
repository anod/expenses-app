import type { Logger } from 'pino';
import {
  calculateEsop,
  parseEsopUsedRange,
  type EsopCalculationResult,
  type EsopAssumptions,
  type RawCellValue,
  type RawUsedRange,
} from '@expenses/shared';
import { GraphClient, GraphError } from '../graph/graphClient.js';
import { WorkbookResolver, type DriveItemRef } from '../graph/workbookResolver.js';
import { encodeWorksheetName } from '../graph/graphReader.js';

const USED_RANGE_SELECT = 'address,rowCount,columnCount,values,text,numberFormat';
const MARKET_RATE_FALLBACK_ROW = 12; // 1-based D12 when the "$/NIS Rate" label is missing
const LOCK_DOWN_FALLBACK_ROW = 14;
const INCOME_TAX_FALLBACK_ROW = 15;

export interface EsopOverrides {
  usdNisRate?: number;
  currentPriceUsd?: number;
  lockDownDays?: number;
  incomeTaxRate?: number;
  asOf?: string;
}

export interface EsopReaderOptions {
  client: GraphClient;
  resolver: WorkbookResolver;
  worksheetName: string;
  log: Logger;
}

export interface EsopMarketValues {
  usdNisRate: number;
  currentPriceUsd: number;
  /** ISO datetime the rate was fetched. Defaults to now when omitted. */
  usdNisRateUpdatedAt?: string;
  /** ISO datetime the price was fetched. Defaults to now when omitted. */
  currentPriceUsdUpdatedAt?: string;
}

export interface EsopWorkbookSettings {
  lockDownDays: number;
  incomeTaxRate: number;
}

export class GraphEsopReader {
  constructor(private readonly opts: EsopReaderOptions) {}

  async read(accessToken: string, overrides: EsopOverrides = {}): Promise<EsopCalculationResult> {
    const ref = await this.opts.resolver.resolve(accessToken);
    const usedRange = await this.fetchUsedRange(accessToken, ref);
    const parsed = parseEsopUsedRange(usedRange);
    const assumptions: EsopAssumptions = {
      ...parsed.assumptions,
      ...definedOverrides(overrides),
      asOf: overrides.asOf ?? todayIsoUtc(),
    };
    const result = calculateEsop(parsed.grants, assumptions);
    const warnings = [...parsed.warnings, ...result.warnings];
    if (warnings.length > 0) {
      this.opts.log.warn({ warnings }, 'esop calculation has warnings');
    }
    return { ...result, warnings };
  }

  async readMeta(accessToken: string): Promise<DriveItemRef> {
    return this.opts.resolver.resolve(accessToken);
  }

  async updateMarketValues(
    accessToken: string,
    values: EsopMarketValues,
  ): Promise<EsopCalculationResult> {
    const ref = await this.opts.resolver.resolve(accessToken);
    // Locate the "$/NIS Rate" row by label so we write to the same cells the
    // reader reads back. Hard-coding D12:D13 silently missed after the sheet was
    // restructured, which is why refreshes appeared to do nothing.
    const usedRange = await this.fetchUsedRange(accessToken, ref);
    const { rateRow, priceRow } = marketValueRows(usedRange.values);
    const ws = encodeWorksheetName(this.opts.worksheetName);
    const now = new Date().toISOString();

    // Write the values (preserving the user's existing number format)...
    await this.opts.client.request({
      method: 'PATCH',
      path: rangePath(ref, ws, `D${rateRow}:D${priceRow}`),
      accessToken,
      body: { values: [[values.usdNisRate], [values.currentPriceUsd]] },
    });
    // ...then stamp when each was last refreshed in the adjacent column, as
    // text so the ISO strings round-trip instead of being coerced to serials.
    await this.opts.client.request({
      method: 'PATCH',
      path: rangePath(ref, ws, `E${rateRow}:E${priceRow}`),
      accessToken,
      body: {
        values: [
          [values.usdNisRateUpdatedAt ?? now],
          [values.currentPriceUsdUpdatedAt ?? now],
        ],
        numberFormat: [['@'], ['@']],
      },
    });
    return this.read(accessToken);
  }

  async updateWorkbookSettings(
    accessToken: string,
    values: EsopWorkbookSettings,
  ): Promise<EsopCalculationResult> {
    const ref = await this.opts.resolver.resolve(accessToken);
    const usedRange = await this.fetchUsedRange(accessToken, ref);
    const targets = workbookSettingTargets(usedRange.values);
    const ws = encodeWorksheetName(this.opts.worksheetName);

    await Promise.all([
      this.opts.client.request({
        method: 'PATCH',
        path: rangePath(ref, ws, targets.lockDownDays),
        accessToken,
        body: { values: [[values.lockDownDays]] },
      }),
      this.opts.client.request({
        method: 'PATCH',
        path: rangePath(ref, ws, targets.incomeTaxRate),
        accessToken,
        body: { values: [[values.incomeTaxRate]] },
      }),
    ]);
    return this.read(accessToken);
  }

  private async fetchUsedRange(accessToken: string, ref: DriveItemRef): Promise<RawUsedRange> {
    const ws = encodeWorksheetName(this.opts.worksheetName);
    const path =
      `/drives/${ref.driveId}/items/${ref.itemId}/workbook/worksheets('${ws}')` +
      `/usedRange(valuesOnly=true)?$select=${USED_RANGE_SELECT}`;
    try {
      return await this.opts.client.request<RawUsedRange>({ path, accessToken });
    } catch (err) {
      if (err instanceof GraphError && err.status === 404) {
        this.opts.resolver.invalidate();
      }
      throw err;
    }
  }
}

function rangePath(ref: DriveItemRef, worksheet: string, address: string): string {
  return (
    `/drives/${ref.driveId}/items/${ref.itemId}/workbook/worksheets('${worksheet}')` +
    `/range(address='${address}')`
  );
}

function workbookSettingTargets(values: RawCellValue[][]): EsopWorkbookSettingsRecord {
  return {
    lockDownDays: settingCellAddress(values, 'lock down period', LOCK_DOWN_FALLBACK_ROW),
    incomeTaxRate: settingCellAddress(values, 'income tax', INCOME_TAX_FALLBACK_ROW),
  };
}

/**
 * Locate the market-value rows by the "$/NIS Rate" label so writes land on the
 * exact cells the parser reads. The current stock price sits on the next row.
 * Falls back to the canonical D12/D13 layout when the label can't be found.
 */
function marketValueRows(values: RawCellValue[][]): { rateRow: number; priceRow: number } {
  const rateIndex = values.findIndex((row) => normalizeHeader(row?.[0]) === '$/nis rate');
  const rateRow = rateIndex >= 0 ? rateIndex + 1 : MARKET_RATE_FALLBACK_ROW;
  return { rateRow, priceRow: rateRow + 1 };
}

interface EsopWorkbookSettingsRecord {
  lockDownDays: string;
  incomeTaxRate: string;
}

function settingCellAddress(values: RawCellValue[][], label: string, fallbackRow: number): string {
  const rowIndex = values.findIndex((row) => normalizeHeader(row?.[0]) === label);
  return `D${rowIndex >= 0 ? rowIndex + 1 : fallbackRow}`;
}

function normalizeHeader(value: RawCellValue | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function definedOverrides(overrides: EsopOverrides): Partial<Omit<EsopAssumptions, 'asOf'>> {
  return Object.fromEntries(
    Object.entries({
      usdNisRate: overrides.usdNisRate,
      currentPriceUsd: overrides.currentPriceUsd,
      lockDownDays: overrides.lockDownDays,
      incomeTaxRate: overrides.incomeTaxRate,
    }).filter(([, value]) => value !== undefined),
  ) as Partial<Omit<EsopAssumptions, 'asOf'>>;
}

function todayIsoUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
