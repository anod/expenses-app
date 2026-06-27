import { Router } from 'express';
import { z } from 'zod';
import type { StateRepo } from '../db/stateRepo.js';
import type { ExcelWriter, SyncMode } from '../graph/excelWriter.js';

const backupBodySchema = z
  .object({
    targetSheet: z.string().trim().min(1).max(31).optional(),
    rawSheetName: z.string().trim().min(1).max(31).optional(),
    mode: z.enum(['overwrite', 'new']).optional(),
  })
  .strict();

export const buildBackupRoutes = (
  getRepo: () => StateRepo,
  writer: ExcelWriter | null,
  isDemo: () => boolean,
): Router => {
  const router = Router();

  router.post('/backup/excel', async (req, res, next) => {
    try {
      if (isDemo()) {
        res.status(409).json({
          error: 'DEMO_MODE_ACTIVE',
          message: 'Excel backup is disabled while demo mode is on. Turn off demo mode in Settings to back up.',
        });
        return;
      }
      if (!writer) {
        res.status(503).json({
          error: 'GRAPH_NOT_CONFIGURED',
          message: 'Excel backup is unavailable: no Graph workbook is configured for this server.',
        });
        return;
      }
      const parsed = backupBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'BAD_REQUEST', issues: parsed.error.issues });
        return;
      }
      const mode: SyncMode = parsed.data.mode ?? 'overwrite';
      const repo = getRepo();
      const state = {
        account: repo.getAccount(),
        cards: repo.listCards(),
        recurring: repo.listRecurring(),
        ledger: repo.listLedger(),
        settings: repo.getSettings(),
      };
      const opts: { targetSheet?: string; rawSheetName?: string; mode: SyncMode } = { mode };
      if (parsed.data.targetSheet !== undefined) opts.targetSheet = parsed.data.targetSheet;
      if (parsed.data.rawSheetName !== undefined) opts.rawSheetName = parsed.data.rawSheetName;
      if (!req.graphToken) {
        res.status(400).json({
          error: 'GRAPH_TOKEN_MISSING',
          message: 'X-MS-Graph-Token header is required for Excel backup',
        });
        return;
      }
      const result = await writer.sync(state, req.graphToken, opts);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
};
