import type { Logger } from 'pino';
import {
  calculateEsop,
  parseEsopUsedRange,
  type EsopCalculationResult,
  type EsopAssumptions,
  type RawUsedRange,
} from '@expenses/shared';
import { GraphClient, GraphError } from '../graph/graphClient.js';
import { WorkbookResolver, type DriveItemRef } from '../graph/workbookResolver.js';
import { encodeWorksheetName } from '../graph/graphReader.js';

const USED_RANGE_SELECT = 'address,rowCount,columnCount,values,numberFormat';
const MARKET_VALUES_RANGE = 'D12:D13';

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
    overrides: Omit<EsopOverrides, 'usdNisRate' | 'currentPriceUsd'> = {},
  ): Promise<EsopCalculationResult> {
    const ref = await this.opts.resolver.resolve(accessToken);
    const ws = encodeWorksheetName(this.opts.worksheetName);
    const path =
      `/drives/${ref.driveId}/items/${ref.itemId}/workbook/worksheets('${ws}')` +
      `/range(address='${MARKET_VALUES_RANGE}')`;
    await this.opts.client.request({
      method: 'PATCH',
      path,
      accessToken,
      body: { values: [[values.usdNisRate], [values.currentPriceUsd]] },
    });
    return this.read(accessToken, overrides);
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
