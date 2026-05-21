import { Router } from 'express';
import { z, ZodError } from 'zod';
import type { GraphEsopReader, EsopOverrides } from './graphEsopReader.js';
import { fetchYahooQuote } from './marketData.js';

const Query = z.object({
  usdNisRate: z.coerce.number().positive().optional(),
  currentPriceUsd: z.coerce.number().nonnegative().optional(),
  lockDownDays: z.coerce.number().positive().optional(),
  incomeTaxRate: z.coerce.number().min(0).max(1).optional(),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const MarketQuery = z.object({
  stockSymbol: z.string().trim().min(1).default('MNDY'),
  fxSymbol: z.string().trim().min(1).default('USDILS=X'),
});

export const buildEsopRoutes = (
  reader: GraphEsopReader | null,
  isDemo: () => boolean,
): Router => {
  const router = Router();

  router.get('/esop/market', async (req, res, next) => {
    try {
      const query = MarketQuery.parse(req.query);
      const [stock, fx] = await Promise.all([
        fetchYahooQuote(query.stockSymbol),
        fetchYahooQuote(query.fxSymbol),
      ]);
      res.json({
        stock,
        fx,
        currentPriceUsd: stock.price,
        usdNisRate: fx.price,
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({ error: 'VALIDATION', issues: err.issues });
        return;
      }
      next(err);
    }
  });

  router.get('/esop', async (req, res, next) => {
    try {
      if (isDemo()) {
        res.status(409).json({
          error: 'DEMO_MODE_ACTIVE',
          message: 'ESOP workbook view is disabled in demo mode.',
        });
        return;
      }
      if (!reader) {
        res.status(501).json({
          error: 'ESOP_NOT_CONFIGURED',
          message: 'Set ESOP_WORKBOOK_URL and run in graph mode to enable ESOP.',
        });
        return;
      }
      if (!req.graphToken) {
        res.status(401).json({
          error: 'GRAPH_TOKEN_REQUIRED',
          message: 'Missing X-MS-Graph-Token header.',
        });
        return;
      }
      const overrides = Query.parse(req.query) as EsopOverrides;
      res.json(await reader.read(req.graphToken, overrides));
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({ error: 'VALIDATION', issues: err.issues });
        return;
      }
      next(err);
    }
  });

  router.get('/esop/status', async (req, res, next) => {
    try {
      if (isDemo()) {
        res.status(409).json({
          error: 'DEMO_MODE_ACTIVE',
          message: 'ESOP workbook status is unavailable in demo mode.',
        });
        return;
      }
      if (!reader) {
        res.status(501).json({
          error: 'ESOP_NOT_CONFIGURED',
          message: 'Set ESOP_WORKBOOK_URL and run in graph mode to enable ESOP.',
        });
        return;
      }
      if (!req.graphToken) {
        res.status(401).json({
          error: 'GRAPH_TOKEN_REQUIRED',
          message: 'Missing X-MS-Graph-Token header.',
        });
        return;
      }
      const workbook = await reader.readMeta(req.graphToken);
      res.json({ source: 'graph', workbook, fetchedAt: new Date().toISOString() });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
