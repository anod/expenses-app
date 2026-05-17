import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { DemoController } from './demoController.js';

const body = z.object({ enabled: z.boolean() }).strict();

/**
 * Demo toggle.
 *
 * - `GET /demo` is always public — it just reports the current mode so the
 *   SPA can decide whether to initialize MSAL.
 * - `POST /demo enabled:true` swaps the live SQLite repo for an in-memory
 *   fake. An attacker flipping this on without auth could confuse a
 *   legitimate signed-in user, so it is gated behind `requireBearer` when
 *   the app runs in protected mode.
 * - `POST /demo enabled:false` is the only escape hatch out of demo mode,
 *   and because demo bypasses MSAL the SPA holds no Bearer token to send.
 *   Allowing the OFF transition unauthenticated is safe: it only swaps
 *   demo data for real data, which is itself protected by the Bearer gate
 *   on every read/write route.
 */
export const buildDemoRoutes = (
  controller: DemoController,
  guard: RequestHandler | null,
): Router => {
  const router = Router();

  router.get('/demo', (_req, res) => {
    res.json({ enabled: controller.isActive() });
  });

  const passthrough: RequestHandler = (_req, _res, next) => next();
  const requireAuthForEnable: RequestHandler = (req, res, next) => {
    if (req.body?.enabled === true) {
      (guard ?? passthrough)(req, res, next);
      return;
    }
    next();
  };

  router.post('/demo', requireAuthForEnable, (req, res) => {
    const parsed = body.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'BAD_REQUEST', issues: parsed.error.issues });
      return;
    }
    const next = controller.setActive(parsed.data.enabled);
    res.json({ enabled: next });
  });

  return router;
};
