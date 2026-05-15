import type { Request, Response, NextFunction } from 'express';

declare global {
  namespace Express {
    interface Request {
      accessToken?: string;
    }
  }
}

const BEARER = /^Bearer\s+(.+)$/i;

/**
 * Requires `Authorization: Bearer <token>` on the request and stashes the
 * raw token on `req.accessToken`. We don't validate the JWT — Microsoft
 * Graph itself rejects invalid tokens with 401, which we surface to the
 * caller verbatim. For multi-tenant prod, validate against the JWKS here.
 */
export function requireBearer(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('Authorization');
  const m = header ? BEARER.exec(header) : null;
  if (!m || !m[1]) {
    res
      .status(401)
      .set('WWW-Authenticate', 'Bearer realm="expenses-api"')
      .json({ error: 'UNAUTHENTICATED', message: 'Missing Authorization: Bearer <token>' });
    return;
  }
  req.accessToken = m[1];
  next();
}
