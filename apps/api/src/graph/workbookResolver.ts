import { Buffer } from 'node:buffer';
import type { Logger } from 'pino';
import { GraphClient, GraphError } from './graphClient.js';

export interface DriveItemRef {
  driveId: string;
  itemId: string;
  name: string;
  lastModifiedDateTime: string | null;
  webUrl: string | null;
}

/**
 * Encode a sharing URL into the `u!` token used by /shares/{token}/driveItem.
 * https://learn.microsoft.com/en-us/graph/api/shares-get
 */
export function encodeSharingUrl(url: string): string {
  const b64 = Buffer.from(url, 'utf8').toString('base64');
  // base64url, no padding
  const safe = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `u!${safe}`;
}

export class WorkbookResolver {
  private cached: DriveItemRef | null = null;

  constructor(
    private readonly client: GraphClient,
    private readonly sharingUrl: string,
    private readonly log: Logger,
  ) {}

  invalidate(): void {
    this.cached = null;
  }

  async resolve(accessToken: string): Promise<DriveItemRef> {
    if (this.cached) return this.cached;
    const token = encodeSharingUrl(this.sharingUrl);
    try {
      const item = await this.client.request<RawDriveItem>({
        path: `/shares/${token}/driveItem?$select=id,name,parentReference,lastModifiedDateTime,webUrl`,
        accessToken,
      });
      const ref: DriveItemRef = {
        driveId: item.parentReference?.driveId ?? '',
        itemId: item.id,
        name: item.name,
        lastModifiedDateTime: item.lastModifiedDateTime ?? null,
        webUrl: item.webUrl ?? null,
      };
      if (!ref.driveId || !ref.itemId) {
        throw new Error('driveItem response missing driveId or itemId');
      }
      this.cached = ref;
      this.log.debug({ driveId: ref.driveId, itemId: ref.itemId }, 'resolved workbook');
      return ref;
    } catch (err) {
      if (err instanceof GraphError && err.status === 404) {
        this.invalidate();
      }
      throw err;
    }
  }
}

interface RawDriveItem {
  id: string;
  name: string;
  parentReference?: { driveId?: string };
  lastModifiedDateTime?: string;
  webUrl?: string;
}
