import { Router, type Request, type Response } from 'express';
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
  stockSymbol: z.string().trim().min(1).default('MSFT'),
  fxSymbol: z.string().trim().min(1).default('USDILS=X'),
});

const MarketUpdateBody = MarketQuery.extend({
  lockDownDays: z.coerce.number().positive().optional(),
  incomeTaxRate: z.coerce.number().min(0).max(1).optional(),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
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

  router.post('/esop/market/update', async (req, res, next) => {
    try {
      if (isDemo()) {
        res.status(409).json({
          error: 'DEMO_MODE_ACTIVE',
          message: 'ESOP workbook updates are disabled in demo mode.',
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
      const graphToken = graphTokenFromHeader(req, res);
      if (!graphToken) return;

      const body = MarketUpdateBody.parse(req.body ?? {});
      const [stock, fx] = await Promise.all([
        fetchYahooQuote(body.stockSymbol),
        fetchYahooQuote(body.fxSymbol),
      ]);
      const overrides: Omit<EsopOverrides, 'usdNisRate' | 'currentPriceUsd'> = {};
      if (body.lockDownDays !== undefined) overrides.lockDownDays = body.lockDownDays;
      if (body.incomeTaxRate !== undefined) overrides.incomeTaxRate = body.incomeTaxRate;
      if (body.asOf !== undefined) overrides.asOf = body.asOf;
      const esop = await reader.updateMarketValues(
        graphToken,
        { usdNisRate: fx.price, currentPriceUsd: stock.price },
        overrides,
      );
      res.json({
        stock,
        fx,
        applied: {
          usdNisRate: esop.assumptions.usdNisRate,
          currentPriceUsd: esop.assumptions.currentPriceUsd,
        },
        esop,
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
      const graphToken = graphTokenFromHeader(req, res);
      if (!graphToken) return;
      const overrides = Query.parse(req.query) as EsopOverrides;
      res.json(await reader.read(graphToken, overrides));
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
      const graphToken = graphTokenFromHeader(req, res);
      if (!graphToken) return;
      const workbook = await reader.readMeta(graphToken);
      res.json({ source: 'graph', workbook, fetchedAt: new Date().toISOString() });
    } catch (err) {
      next(err);
    }
  });

  return router;
};

function graphTokenFromHeader(req: Request, res: Response): string | null {
  const header = req.header('X-MS-Graph-Token');
  if (!header?.trim()) {
    res.status(401).json({
      error: 'GRAPH_TOKEN_REQUIRED',
      message: 'Missing X-MS-Graph-Token header.',
    });
    return null;
  }
  return header.trim();
}
