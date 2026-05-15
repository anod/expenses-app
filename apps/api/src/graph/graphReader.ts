import type { Logger } from 'pino';
import {
  parseWorkbookDump,
  type RawWorkbookDump,
  type RawUsedRange,
  type WorkbookSnapshot,
} from '@expenses/shared';
import { GraphClient, GraphError } from './graphClient.js';
import { WorkbookResolver, type DriveItemRef } from './workbookResolver.js';

const USED_RANGE_SELECT = 'address,rowCount,columnCount,values,formulas,numberFormat';

export interface GraphReaderOptions {
  client: GraphClient;
  resolver: WorkbookResolver;
  worksheetName: string;
  log: Logger;
}

export class GraphReader {
  constructor(private readonly opts: GraphReaderOptions) {}

  async readSnapshot(accessToken: string): Promise<WorkbookSnapshot> {
    const ref = await this.opts.resolver.resolve(accessToken);
    const usedRange = await this.fetchUsedRange(accessToken, ref);

    const dump: RawWorkbookDump = {
      workbook: {
        name: ref.name,
        worksheet: this.opts.worksheetName,
        lastModifiedDateTime: ref.lastModifiedDateTime,
      },
      usedRange,
      dumpedAt: new Date().toISOString(),
    };

    const snapshot = parseWorkbookDump(dump, { fetchedAt: new Date().toISOString() });
    if (snapshot.warnings.length > 0) {
      this.opts.log.warn({ warnings: snapshot.warnings }, 'snapshot has parser warnings');
    }
    return snapshot;
  }

  async readMeta(accessToken: string): Promise<DriveItemRef> {
    return this.opts.resolver.resolve(accessToken);
  }

  private async fetchUsedRange(accessToken: string, ref: DriveItemRef): Promise<RawUsedRange> {
    const ws = encodeURIComponent(this.opts.worksheetName);
    const path =
      `/drives/${ref.driveId}/items/${ref.itemId}/workbook/worksheets('${ws}')` +
      `/usedRange?$select=${USED_RANGE_SELECT}`;
    try {
      return await this.opts.client.request<RawUsedRange>({ path, accessToken });
    } catch (err) {
      if (err instanceof GraphError && err.status === 404) {
        // Workbook may have moved/renamed; force re-resolution next request.
        this.opts.resolver.invalidate();
      }
      throw err;
    }
  }
}
