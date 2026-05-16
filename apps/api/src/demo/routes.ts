import { Router } from 'express';
import { z } from 'zod';
import type { DemoController } from './demoController.js';

const body = z.object({ enabled: z.boolean() }).strict();

export const buildDemoRoutes = (controller: DemoController): Router => {
  const router = Router();

  router.get('/demo', (_req, res) => {
    res.json({ enabled: controller.isActive() });
  });

  router.post('/demo', (req, res) => {
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
