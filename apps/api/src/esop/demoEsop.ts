import {
  calculateEsop,
  type EsopAssumptions,
  type EsopCalculationResult,
  type EsopGrant,
} from '@expenses/shared';
import type { EsopOverrides } from './graphEsopReader.js';

const DEMO_GRANTS: EsopGrant[] = [
  {
    id: 'demo:esop:2021',
    grantDate: '2021-09-01',
    grantPriceUsd: 210,
    amount: 12,
    unblockMay31Amount: 4,
    unblockAug31Amount: 4,
  },
  {
    id: 'demo:esop:2022',
    grantDate: '2022-09-01',
    grantPriceUsd: 245,
    amount: 18,
    unblockMay31Amount: 6,
    unblockAug31Amount: 6,
  },
  {
    id: 'demo:esop:2024',
    grantDate: '2024-09-01',
    grantPriceUsd: 375,
    amount: 24,
    unblockMay31Amount: 8,
    unblockAug31Amount: 8,
  },
];

const DEMO_ASSUMPTIONS = {
  usdNisRate: 3.7,
  currentPriceUsd: 430,
  lockDownDays: 730,
  incomeTaxRate: 0.55,
};

export function calculateDemoEsop(overrides: EsopOverrides = {}): EsopCalculationResult {
  return calculateEsop(DEMO_GRANTS, {
    ...DEMO_ASSUMPTIONS,
    ...definedOverrides(overrides),
    asOf: overrides.asOf ?? todayIsoUtc(),
  });
}

function definedOverrides(
  overrides: EsopOverrides,
): Partial<Omit<EsopAssumptions, 'asOf'>> {
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
