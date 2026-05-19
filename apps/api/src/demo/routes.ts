import { Router } from 'express';
import { z } from 'zod';
import type { DemoController } from './demoController.js';

const body = z.object({ enabled: z.boolean() }).strict();

/**
 * Demo toggle.
 *
 * Both GET and POST are public. The "Try demo mode" button on the sign-in
 * landing has no Bearer to send, so the toggle cannot require auth.
 *
 * Browser CSRF (a malicious website coercing a signed-in user's browser
 * into flipping demo on) is mitigated by an Origin/Referer check against
 * `allowedOrigin` (the configured `CORS_ORIGIN`). Non-browser clients
 * (curl, scripts) typically omit `Origin`; those are allowed, on the
 * understanding that this deployment relies on network-level access
 * control (e.g. Tailscale) to gate raw HTTP reachability.
 */
export const buildDemoRoutes = (
  controller: DemoController,
  allowedOrigin: string,
): Router => {
  const router = Router();

  router.get('/demo', (_req, res) => {
    res.json({ enabled: controller.isActive() });
  });

  router.post('/demo', (req, res) => {
    const origin = req.header('origin');
    const referer = req.header('referer');
    const fromBrowser = origin !== undefined || referer !== undefined;
    if (fromBrowser) {
      const originOk = origin !== undefined && origin === allowedOrigin;
      const refererOk =
        referer !== undefined &&
        (referer === allowedOrigin || referer.startsWith(allowedOrigin + '/'));
      if (!originOk && !refererOk) {
        res.status(403).json({
          error: 'FORBIDDEN_ORIGIN',
          message: 'Origin/Referer does not match the allow-listed SPA origin.',
        });
        return;
      }
    }
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
