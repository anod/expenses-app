import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { calculateEsop } from '@expenses/shared';
import { ForecastApi } from '../forecast/forecast.api';
import { EsopPageComponent } from './esop-page';

const saved = {
  ...calculateEsop(
    [
      {
        id: 'old',
        grantDate: '2020-01-01',
        grantPriceUsd: 100,
        amount: 10,
        unlocks: [{ date: '2026-06-01', amount: 5 }],
      },
      {
        id: 'locked',
        grantDate: '2026-01-01',
        grantPriceUsd: 100,
        amount: 10,
        unlocks: [{ date: '2026-06-01', amount: 5 }],
      },
    ],
    {
      usdNisRate: 3,
      currentPriceUsd: 200,
      lockDownDays: 730,
      incomeTaxRate: 0.5,
      asOf: '2026-05-01',
      usdNisRateUpdatedAt: '2026-05-01T00:00:00Z',
    },
  ),
  warnings: ['Workbook warning'],
};

class Harness extends EsopPageComponent {
  readonly displayed = this.result;
  readonly active = this.simulating;
  readonly rate = this.simulatedRate;
  readonly price = this.simulatedPrice;
  readonly validationError = this.simulationError;
  toggle(): void {
    this.toggleSimulation();
  }
  update(): Promise<void> {
    return this.refresh();
  }
}

async function setup() {
  const api = {
    getEsop: vi.fn(() => of(saved)),
    getSettings: vi.fn(() => of({})),
    updateEsopMarket: vi.fn(() =>
      of({ esop: saved, stock: { symbol: 'MSFT' }, fx: { symbol: 'USDILS=X' } }),
    ),
  };
  const injector = Injector.create({ providers: [{ provide: ForecastApi, useValue: api }] });
  const page = runInInjectionContext(injector, () => new Harness());
  await Promise.resolve();
  return { page, api };
}

describe('ESOP temporary price simulation', () => {
  it('revalues totals, locked grants, and unlock forecasts locally without changing saved data', async () => {
    const { page, api } = await setup();
    page.toggle();
    expect(page.rate()).toBe(3);
    expect(page.price()).toBe(200);
    page.rate.set(4);
    page.price.set(250);

    const result = page.displayed()!;
    expect(result.totals.grossNis).toBe(20_000);
    expect(result.totals.incomeTaxNis).toBe(4_000);
    expect(result.totals.stockTaxNis).toBe(4_500);
    expect(result.totals.netNis).toBe(11_500);
    expect(result.pastLockdownTotals.netNis).toBe(6_500);
    expect(result.unblockForecasts[0]).toMatchObject({
      sumNis: 30_000,
      netNis: 17_250,
      netDeltaNis: 5_750,
    });
    expect(result.warnings).toEqual(saved.warnings);
    expect(saved.assumptions.usdNisRate).toBe(3);
    expect(saved.assumptions.currentPriceUsd).toBe(200);
    await page.update();
    expect(api.updateEsopMarket).not.toHaveBeenCalled();

    page.toggle();
    expect(page.active()).toBe(false);
    expect(page.displayed()).toBe(saved);
    expect(page.rate()).toBeNull();
    page.toggle();
    expect(page.rate()).toBe(3);
    expect(page.price()).toBe(200);
  });

  it.each([null, 0, -1, NaN, Infinity])(
    'rejects invalid inputs (%s) with a visible error',
    async (value) => {
      const { page } = await setup();
      page.toggle();
      page.rate.set(value);
      expect(page.validationError()).toBeTruthy();
      expect(page.displayed()).toBe(saved);
      page.rate.set(3);
      page.price.set(value);
      expect(page.validationError()).toBeTruthy();
      expect(page.displayed()).toBe(saved);
      page.price.set(250);
      expect(page.validationError()).toBeNull();
      expect(page.displayed()?.assumptions.currentPriceUsd).toBe(250);
    },
  );

  it('rejects overflowing calculations and discards the preview when leaving the page', async () => {
    const { page } = await setup();
    page.toggle();
    page.price.set(Number.MAX_VALUE);
    expect(page.validationError()).toContain('too large');
    expect(page.displayed()).toBe(saved);
    const { page: reopened } = await setup();
    expect(reopened.active()).toBe(false);
    expect(reopened.displayed()).toBe(saved);
  });
});
