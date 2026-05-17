import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload } from 'jose';

declare global {
  namespace Express {
    interface Request {
      /**
       * Validated Microsoft `oid` (object id) of the caller. Set by
       * `buildBearerGuard`'s middleware after successful JWT validation.
       */
      account?: { oid: string; name?: string };
      /**
       * Optional Graph access token forwarded by the SPA in the
       * `X-MS-Graph-Token` header for routes that need to call MS Graph.
       * Distinct from the API audience Bearer used to gate `/api/*`.
       */
      graphToken?: string;
    }
  }
}

const BEARER = /^Bearer\s+(.+)$/i;

const unauth = (res: Response, error: string, description: string): void => {
  res
    .status(401)
    .set(
      'WWW-Authenticate',
      `Bearer realm="expenses-api", error="${error}", error_description="${description}"`,
    )
    .json({ error: 'UNAUTHENTICATED', message: description });
};

export interface BearerGuardOptions {
  tenantId: string;
  audiences: string[];
  allowedOids: string[];
  /**
   * Override the JWKS URL — used by tests to point at a local mock.
   * When omitted, defaults to the Microsoft v2.0 keys endpoint for the
   * given `tenantId`.
   */
  jwksUrl?: URL;
  /**
   * Override the expected issuer string. When omitted, defaults to
   * `https://login.microsoftonline.com/<tenantId>/v2.0`. Tests use this
   * to match a mock issuer.
   */
  issuer?: string;
}

/**
 * Construct an Express middleware that validates the `Authorization:
 * Bearer <jwt>` header against Microsoft's JWKS for the given tenant.
 *
 * Validation rules:
 *   1. Standard JWT signature (RS256 via JWKS), `iss`, `aud`, `exp`, `nbf`.
 *   2. `ver` must equal `"2.0"` (we do not accept v1 tokens).
 *   3. `scp` must contain `access` — guards against accepting ID tokens
 *      (ID tokens have no `scp` claim). Without this, an ID token with
 *      the same `aud` would pass.
 *   4. `oid` must appear in `allowedOids` — binds the API to a specific
 *      Microsoft account, not "any consenting MSA user".
 *
 * On any failure: 401 with a `WWW-Authenticate` header carrying a short
 * machine-readable reason. The reason is also exposed in the JSON body.
 */
export const buildBearerGuard = (opts: BearerGuardOptions): RequestHandler => {
  const jwksUrl =
    opts.jwksUrl ??
    new URL(`https://login.microsoftonline.com/${opts.tenantId}/discovery/v2.0/keys`);
  const issuer = opts.issuer ?? `https://login.microsoftonline.com/${opts.tenantId}/v2.0`;
  const jwks = createRemoteJWKSet(jwksUrl);
  const allowedOids = new Set(opts.allowedOids);

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.header('Authorization');
    const m = header ? BEARER.exec(header) : null;
    if (!m || !m[1]) {
      unauth(res, 'invalid_request', 'Missing Authorization: Bearer <token>');
      return;
    }
    const token = m[1];

    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(token, jwks, {
        issuer,
        audience: opts.audiences,
      });
      payload = verified.payload;
    } catch (err) {
      const code =
        err instanceof joseErrors.JWTExpired
          ? 'token_expired'
          : err instanceof joseErrors.JWTClaimValidationFailed
            ? 'invalid_claims'
            : 'invalid_token';
      unauth(res, code, err instanceof Error ? err.message : String(err));
      return;
    }

    if (payload.ver !== '2.0') {
      unauth(res, 'invalid_token', 'Only v2.0 tokens are accepted');
      return;
    }

    // `scp` is space-separated for delegated tokens. Absence indicates an
    // ID token (or app-roles token without scopes), which we never accept
    // on this endpoint — only delegated access tokens.
    const scp = typeof payload.scp === 'string' ? payload.scp : '';
    if (!scp.split(/\s+/).includes('access')) {
      unauth(res, 'insufficient_scope', "Token is missing the 'access' scope");
      return;
    }

    const oid = typeof payload.oid === 'string' ? payload.oid : '';
    if (!oid || !allowedOids.has(oid)) {
      // 403 (not 401) — token is valid but the principal is not authorised.
      res
        .status(403)
        .json({ error: 'FORBIDDEN', message: 'Account is not on the allowlist' });
      return;
    }

    const account: { oid: string; name?: string } = { oid };
    if (typeof payload.name === 'string') account.name = payload.name;
    req.account = account;
    next();
  };
};

/**
 * Reads the Graph access token from `X-MS-Graph-Token`. Routes that
 * passthrough to Microsoft Graph must call this *after* the Bearer
 * guard. Sets `req.graphToken` on success. Returns 400 if missing in
 * protected mode.
 */
export const requireGraphToken = (req: Request, res: Response, next: NextFunction): void => {
  const header = req.header('X-MS-Graph-Token');
  if (!header || header.trim().length === 0) {
    res
      .status(400)
      .json({
        error: 'GRAPH_TOKEN_MISSING',
        message:
          'X-MS-Graph-Token header is required for Microsoft Graph passthrough routes',
      });
    return;
  }
  req.graphToken = header.trim();
  next();
};
