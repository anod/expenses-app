import type { RawUsedRange } from '../parsers/usedRange.js';

export interface EsopGrant {
  id: string;
  grantDate: string;
  grantPriceUsd: number;
  amount: number;
  unblockMay31Amount?: number;
  unblockAug31Amount?: number;
}

export interface EsopAssumptions {
  usdNisRate: number;
  currentPriceUsd: number;
  lockDownDays: number;
  incomeTaxRate: number;
  asOf: string;
  unblockMay31Date?: string;
  unblockAug31Date?: string;
}

export interface EsopComputedGrant extends EsopGrant {
  ageDays: number;
  grossNis: number;
  incomeTaxNis: number;
  stockTaxNis: number;
  netNis: number;
  effectiveTaxRate: number | null;
  stockTaxRate: number;
}

export interface EsopTotals {
  grossNis: number;
  incomeTaxNis: number;
  stockTaxNis: number;
  netNis: number;
  effectiveTaxRate: number | null;
}

export interface EsopUnblockForecast {
  id: 'may31' | 'aug31';
  label: string;
  asOf: string;
  unlockedAmount: number;
  totalAmount: number;
  sumNis: number;
  netNis: number;
  sumDeltaNis: number;
  netDeltaNis: number;
}

export interface EsopCalculationResult {
  assumptions: EsopAssumptions;
  grants: EsopGrant[];
  computed: EsopComputedGrant[];
  totals: EsopTotals;
  unblockForecasts: EsopUnblockForecast[];
  warnings: string[];
}

export interface EsopWorkbookParseResult {
  assumptions: Omit<EsopAssumptions, 'asOf'>;
  grants: EsopGrant[];
  warnings: string[];
}

export interface EsopWorkbookDump {
  workbook: {
    name: string;
    worksheet: string;
    lastModifiedDateTime?: string | null;
  };
  usedRange: RawUsedRange;
  dumpedAt?: string;
}
