import { Router } from 'express';
import type { Logger } from 'pino';
import { computeForecast } from '../forecast/computeForecast.js';
import type { GraphReader } from '../graph/graphReader.js';
import type { StateRepo } from '../db/stateRepo.js';
import { importFromSnapshot } from './importFromSnapshot.js';

/**
 * Import endpoint: pulls the workbook via Graph (using the caller's Bearer)
 * and seeds the active StateRepo idempotently. Returns the import summary
 * plus a fresh ForecastResult so the SPA can refresh in one round-trip.
 *
 * 409 when demo is active (read-only sandbox).
 * 503 when graph reader is not configured (dump mode / missing env).
 */
export const buildImportRoutes = (
  getRepo: () => StateRepo,
  graphReader: GraphReader | null,
  isDemo: () => boolean,
  log: Logger,
): Router => {
  const router = Router();

  router.post('/import/excel', async (req, res, next) => {
    try {
      if (isDemo()) {
        res.status(409).json({
          error: 'DEMO_MODE_ACTIVE',
          message: 'Disable demo mode in Settings to import from Excel.',
        });
        return;
      }
      if (!graphReader) {
        res.status(503).json({
          error: 'GRAPH_NOT_CONFIGURED',
          message: 'API is not running with EXPENSES_SOURCE=graph.',
        });
        return;
      }
      if (!req.graphToken) {
        res.status(400).json({
          error: 'GRAPH_TOKEN_MISSING',
          message: 'X-MS-Graph-Token header is required to import from OneDrive.',
        });
        return;
      }
      const snapshot = await graphReader.readSnapshot(req.graphToken);
      const summary = importFromSnapshot(getRepo(), snapshot);
      const forecast = computeForecast(getRepo());
      log.info(
        {
          months: summary.monthsParsed,
          cards: summary.cardsCreated,
          recurring: summary.recurringCreated,
          ledger: summary.ledgerCreated,
          orphanedLedger: summary.orphanedLedger,
          orphanedRecurring: summary.orphanedRecurring,
        },
        'excel import complete',
      );
      res.json({ summary, forecast });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
