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
  /** ISO datetime the USD/NIS rate was last refreshed, or null if unknown. */
  usdNisRateUpdatedAt?: string | null;
  /** ISO datetime the stock price was last refreshed, or null if unknown. */
  currentPriceUsdUpdatedAt?: string | null;
}

export interface EsopComputedGrant extends EsopGrant {
  ageDays: number;
  /**
   * Shares valued in the current calculation: the grant `amount` plus any
   * unlock milestones whose date is on or before `asOf` (folded in because
   * they have already vested). Equals `amount` when nothing has unlocked yet.
   */
  heldAmount: number;
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

/**
 * An unlock milestone whose date is on or before `asOf`. Its shares are already
 * folded into the current holdings/totals; this record lets the UI note it
 * (e.g. "May 31 · +47 shares included") instead of showing it as a forecast.
 */
export interface EsopPastUnlock {
  id: 'may31' | 'aug31';
  label: string;
  date: string;
  amount: number;
}

export interface EsopCalculationResult {
  assumptions: EsopAssumptions;
  grants: EsopGrant[];
  computed: EsopComputedGrant[];
  totals: EsopTotals;
  unblockForecasts: EsopUnblockForecast[];
  /** Unlock milestones already passed (folded into current holdings). */
  pastUnlocks: EsopPastUnlock[];
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
