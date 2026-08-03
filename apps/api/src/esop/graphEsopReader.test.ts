import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { RawUsedRange } from '@expenses/shared';
import { GraphEsopReader } from './graphEsopReader.js';
import type { GraphClient, GraphRequest } from '../graph/graphClient.js';
import type { WorkbookResolver } from '../graph/workbookResolver.js';

/**
 * Build a used range whose "$/NIS Rate" / price rows sit at a caller-chosen
 * position, so we can prove the writer targets cells by label rather than a
 * hard-coded D12:D13 (the old bug that made refreshes silently no-op).
 */
function usedRangeWithRateAt(rateIndex: number): RawUsedRange {
  const blank = ['', '', '', '', ''];
  const values: (string | number)[][] = [
    ['Grant Price', 'Grant Date', '', 'Amount', 'Net'],
    [211.02, 44074, '', 11, 8284],
  ];
  while (values.length < rateIndex) values.push([...blank]);
  values[rateIndex] = ['$/NIS Rate', '', '', 2.99, ''];
  values[rateIndex + 1] = ['#VALUE!', '', '', 420.26, ''];
  return {
    address: `ESOP!A1:E${values.length}`,
    rowCount: values.length,
    columnCount: 5,
    values,
  };
}

function mkReader(usedRange: RawUsedRange): { reader: GraphEsopReader; requests: GraphRequest[] } {
  const requests: GraphRequest[] = [];
  const client = {
    request: vi.fn(async (req: GraphRequest) => {
      requests.push(req);
      return (req.method ?? 'GET') === 'GET' ? usedRange : {};
    }),
  } as unknown as GraphClient;
  const resolver = {
    resolve: vi.fn(async () => ({ driveId: 'drive1', itemId: 'item1', name: 'wb.xlsx' })),
    invalidate: vi.fn(),
  } as unknown as WorkbookResolver;
  const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger;
  const reader = new GraphEsopReader({ client, resolver, worksheetName: 'ESOP', log });
  return { reader, requests };
}

const patchesTo = (requests: GraphRequest[]) =>
  requests.filter((r) => r.method === 'PATCH');

describe('GraphEsopReader.updateMarketValues', () => {
  it('writes the rate/price and timestamps to the label-located rows', async () => {
    // Rate at row 17 (index 16), well away from the legacy D12:D13.
    const { reader, requests } = mkReader(usedRangeWithRateAt(16));

    await reader.updateMarketValues('token', {
      usdNisRate: 3.9,
      currentPriceUsd: 512,
      usdNisRateUpdatedAt: '2026-08-03T06:30:00.000Z',
      currentPriceUsdUpdatedAt: '2026-08-03T06:31:00.000Z',
    });

    const patches = patchesTo(requests);
    const valuePatch = patches.find((p) => p.path.includes("address='D17:D18'"));
    const stampPatch = patches.find((p) => p.path.includes("address='E17:E18'"));

    expect(valuePatch, 'value patch should target D17:D18').toBeDefined();
    expect(valuePatch?.body).toEqual({ values: [[3.9], [512]] });

    expect(stampPatch, 'timestamp patch should target E17:E18').toBeDefined();
    expect(stampPatch?.body).toEqual({
      values: [['2026-08-03T06:30:00.000Z'], ['2026-08-03T06:31:00.000Z']],
      numberFormat: [['@'], ['@']],
    });

    // Nothing should be written to the legacy hard-coded cells.
    expect(patches.some((p) => p.path.includes("address='D12:D13'"))).toBe(false);
  });

  it('falls back to D12:D13 when the "$/NIS Rate" label is missing', async () => {
    const usedRange: RawUsedRange = {
      address: 'ESOP!A1:E3',
      rowCount: 3,
      columnCount: 5,
      values: [
        ['Grant Price', 'Grant Date', '', 'Amount', 'Net'],
        [211.02, 44074, '', 11, 8284],
        ['', '', '', '', ''],
      ],
    };
    const { reader, requests } = mkReader(usedRange);

    await reader.updateMarketValues('token', { usdNisRate: 3.5, currentPriceUsd: 400 });

    const patches = patchesTo(requests);
    expect(patches.some((p) => p.path.includes("address='D12:D13'"))).toBe(true);
    expect(patches.some((p) => p.path.includes("address='E12:E13'"))).toBe(true);
  });
});
