import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express, { type Express } from 'express';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { buildBearerGuard, requireGraphToken } from './auth.js';

// ---------- mock JWKS HTTP server ----------

type Keys = {
  privateKey: CryptoKey;
  publicJwk: JWK & { kid: string };
};

let jwksKeys: Keys;
let jwksServer: http.Server;
let jwksUrl: URL;
const KID = 'test-kid-1';
const TENANT = 'test-tenant';
const ISSUER = `https://login.test.local/${TENANT}/v2.0`;
const AUD_API = 'api://00000000-0000-0000-0000-000000000abc';
const AUD_GUID = '00000000-0000-0000-0000-000000000abc';
const OID_OK = 'user-allowed-oid';
const OID_BAD = 'user-blocked-oid';

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid: KID, alg: 'RS256', use: 'sig' } as JWK & {
    kid: string;
  };
  jwksKeys = { privateKey, publicJwk };

  jwksServer = http.createServer((req, res) => {
    if (req.url?.endsWith('/keys')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [publicJwk] }));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => jwksServer.listen(0, '127.0.0.1', r));
  const { port } = jwksServer.address() as AddressInfo;
  jwksUrl = new URL(`http://127.0.0.1:${port}/keys`);
});

afterAll(async () => {
  await new Promise<void>((r) => jwksServer.close(() => r()));
});

interface SignOpts {
  aud?: string | string[];
  iss?: string;
  scp?: string | undefined;
  oid?: string | undefined;
  ver?: string | undefined;
  exp?: number;
  nbf?: number;
  name?: string;
  omitKid?: boolean;
}

async function sign(opts: SignOpts = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    ver: opts.ver === undefined ? '2.0' : opts.ver,
  };
  if (opts.scp !== undefined) payload.scp = opts.scp;
  else if (!('scp' in opts)) payload.scp = 'access';
  if (opts.oid !== undefined) payload.oid = opts.oid;
  else if (!('oid' in opts)) payload.oid = OID_OK;
  if (opts.name) payload.name = opts.name;

  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: opts.omitKid ? undefined : KID })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUD_API)
    .setIssuedAt(now)
    .setExpirationTime(opts.exp ?? now + 300)
    .setNotBefore(opts.nbf ?? now - 60);
  return jwt.sign(jwksKeys.privateKey);
}

// ---------- test app ----------

function buildApp(): Express {
  const app = express();
  const guard = buildBearerGuard({
    tenantId: TENANT,
    audiences: [AUD_API, AUD_GUID],
    allowedOids: [OID_OK],
    jwksUrl,
    issuer: ISSUER,
  });
  app.get('/protected', guard, (req, res) => {
    res.json({ ok: true, account: req.account });
  });
  app.get('/graph', guard, requireGraphToken, (req, res) => {
    res.json({ ok: true, graphToken: req.graphToken });
  });
  return app;
}

async function call(
  app: Express,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; wwwAuth?: string }> {
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address() as AddressInfo;
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    const text = await r.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // keep as text
    }
    return {
      status: r.status,
      body,
      ...(r.headers.get('www-authenticate')
        ? { wwwAuth: r.headers.get('www-authenticate')! }
        : {}),
    };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

// ---------- tests ----------

describe('buildBearerGuard', () => {
  it('accepts a valid token and exposes account on req', async () => {
    const app = buildApp();
    const tok = await sign({ name: 'Alice' });
    const res = await call(app, '/protected', { authorization: `Bearer ${tok}` });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, account: { oid: OID_OK, name: 'Alice' } });
  });

  it('accepts the bare-GUID audience form', async () => {
    const app = buildApp();
    const tok = await sign({ aud: AUD_GUID });
    const res = await call(app, '/protected', { authorization: `Bearer ${tok}` });
    expect(res.status).toBe(200);
  });

  it('rejects missing Authorization header with 401', async () => {
    const app = buildApp();
    const res = await call(app, '/protected');
    expect(res.status).toBe(401);
    expect(res.wwwAuth).toMatch(/error="invalid_request"/);
  });

  it('rejects malformed Bearer header with 401', async () => {
    const app = buildApp();
    const res = await call(app, '/protected', { authorization: 'NotBearer xyz' });
    expect(res.status).toBe(401);
  });

  it('rejects junk Bearer token with 401', async () => {
    const app = buildApp();
    const res = await call(app, '/protected', { authorization: 'Bearer not-a-jwt' });
    expect(res.status).toBe(401);
    expect(res.wwwAuth).toMatch(/error="invalid_token"/);
  });

  it('rejects expired tokens with 401 / token_expired', async () => {
    const app = buildApp();
    const now = Math.floor(Date.now() / 1000);
    const tok = await sign({ exp: now - 60, nbf: now - 120 });
    const res = await call(app, '/protected', { authorization: `Bearer ${tok}` });
    expect(res.status).toBe(401);
    expect(res.wwwAuth).toMatch(/error="token_expired"/);
  });

  it('rejects future nbf with 401', async () => {
    const app = buildApp();
    const now = Math.floor(Date.now() / 1000);
    const tok = await sign({ nbf: now + 600, exp: now + 3600 });
    const res = await call(app, '/protected', { authorization: `Bearer ${tok}` });
    expect(res.status).toBe(401);
  });

  it('rejects wrong audience (graph.microsoft.com) with 401', async () => {
    const app = buildApp();
    const tok = await sign({ aud: 'https://graph.microsoft.com' });
    const res = await call(app, '/protected', { authorization: `Bearer ${tok}` });
    expect(res.status).toBe(401);
  });

  it('rejects wrong issuer with 401', async () => {
    const app = buildApp();
    const tok = await sign({ iss: 'https://attacker.example.com/v2.0' });
    const res = await call(app, '/protected', { authorization: `Bearer ${tok}` });
    expect(res.status).toBe(401);
  });

  it('rejects v1 (ver=1.0) tokens with 401', async () => {
    const app = buildApp();
    const tok = await sign({ ver: '1.0' });
    const res = await call(app, '/protected', { authorization: `Bearer ${tok}` });
    expect(res.status).toBe(401);
  });

  it('rejects ID tokens (missing scp) with 401 / insufficient_scope', async () => {
    const app = buildApp();
    const tok = await sign({ scp: undefined });
    const res = await call(app, '/protected', { authorization: `Bearer ${tok}` });
    expect(res.status).toBe(401);
    expect(res.wwwAuth).toMatch(/error="insufficient_scope"/);
  });

  it("rejects tokens whose scp does not include 'access' with 401", async () => {
    const app = buildApp();
    const tok = await sign({ scp: 'User.Read Files.ReadWrite' });
    const res = await call(app, '/protected', { authorization: `Bearer ${tok}` });
    expect(res.status).toBe(401);
    expect(res.wwwAuth).toMatch(/error="insufficient_scope"/);
  });

  it('returns 403 (not 401) when oid is not in allowlist', async () => {
    const app = buildApp();
    const tok = await sign({ oid: OID_BAD });
    const res = await call(app, '/protected', { authorization: `Bearer ${tok}` });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'FORBIDDEN' });
  });

  it('returns 403 when oid claim is missing entirely', async () => {
    const app = buildApp();
    const tok = await sign({ oid: undefined });
    const res = await call(app, '/protected', { authorization: `Bearer ${tok}` });
    expect(res.status).toBe(403);
  });
});

describe('requireGraphToken', () => {
  it('passes the token through to req.graphToken when present', async () => {
    const app = buildApp();
    const tok = await sign();
    const res = await call(app, '/graph', {
      authorization: `Bearer ${tok}`,
      'x-ms-graph-token': 'graph-abc-123',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, graphToken: 'graph-abc-123' });
  });

  it('returns 400 when X-MS-Graph-Token is missing on a graph route', async () => {
    const app = buildApp();
    const tok = await sign();
    const res = await call(app, '/graph', { authorization: `Bearer ${tok}` });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'GRAPH_TOKEN_MISSING' });
  });

  it('does not require X-MS-Graph-Token on non-graph routes', async () => {
    const app = buildApp();
    const tok = await sign();
    const res = await call(app, '/protected', { authorization: `Bearer ${tok}` });
    expect(res.status).toBe(200);
  });
});
