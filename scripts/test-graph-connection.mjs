#!/usr/bin/env node
// Test Microsoft Graph connection and optionally dump the workbook used range.
// Usage:
//   node scripts/test-graph-connection.mjs           # connect + print metadata
//   node scripts/test-graph-connection.mjs --dump    # also dump used range to JSON

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PublicClientApplication, LogLevel } from '@azure/msal-node';
import 'dotenv/config';

const SCOPES = ['Files.ReadWrite', 'offline_access', 'User.Read'];
const TOKEN_CACHE_PATH = resolve(process.cwd(), '.token-cache.json');
const GRAPH = 'https://graph.microsoft.com/v1.0';

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`Missing required env var: ${name}. See .env.example / SETUP_GRAPH.md.`);
    process.exit(1);
  }
  return v.trim();
}

const CLIENT_ID = requireEnv('MICROSOFT_CLIENT_ID');
const TENANT_ID = process.env.MICROSOFT_TENANT_ID?.trim() || 'consumers';
const WORKBOOK_URL = requireEnv('ONEDRIVE_WORKBOOK_URL');
const WORKSHEET_NAME = process.env.WORKSHEET_NAME?.trim() || 'Sheet1';

const cachePlugin = {
  beforeCacheAccess: async (ctx) => {
    if (existsSync(TOKEN_CACHE_PATH)) {
      ctx.tokenCache.deserialize(await readFile(TOKEN_CACHE_PATH, 'utf8'));
    }
  },
  afterCacheAccess: async (ctx) => {
    if (ctx.cacheHasChanged) {
      await writeFile(TOKEN_CACHE_PATH, ctx.tokenCache.serialize(), { mode: 0o600 });
    }
  },
};

const pca = new PublicClientApplication({
  auth: {
    clientId: CLIENT_ID,
    authority: `https://login.microsoftonline.com/${TENANT_ID}`,
  },
  cache: { cachePlugin },
  system: {
    loggerOptions: {
      logLevel: LogLevel.Warning,
      loggerCallback: (_lvl, msg) => console.error(`[msal] ${msg}`),
      piiLoggingEnabled: false,
    },
  },
});

async function acquireToken() {
  const accounts = await pca.getTokenCache().getAllAccounts();
  if (accounts.length > 0) {
    try {
      const r = await pca.acquireTokenSilent({ account: accounts[0], scopes: SCOPES });
      if (r?.accessToken) return r.accessToken;
    } catch (e) {
      console.error('[auth] silent token acquisition failed, falling back to device code:', e.message);
    }
  }
  const r = await pca.acquireTokenByDeviceCode({
    scopes: SCOPES,
    deviceCodeCallback: (info) => {
      console.log('\n==============================================================');
      console.log(info.message);
      console.log('==============================================================\n');
    },
  });
  if (!r?.accessToken) throw new Error('Failed to acquire access token');
  return r.accessToken;
}

async function graph(token, path, init = {}) {
  const url = path.startsWith('http') ? path : `${GRAPH}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Graph ${init.method || 'GET'} ${path} → ${res.status} ${res.statusText}\n${body}`);
  }
  return res.json();
}

// Convert a OneDrive sharing URL to a Graph "shares/{token}" id per
// https://learn.microsoft.com/graph/api/shares-get
function encodeSharingUrl(url) {
  const b64 = Buffer.from(url, 'utf8').toString('base64');
  return 'u!' + b64.replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
}

async function resolveWorkbook(token) {
  const sharedId = encodeSharingUrl(WORKBOOK_URL);
  const item = await graph(token, `/shares/${sharedId}/driveItem`);
  return item;
}

async function readUsedRange(token, driveId, itemId, worksheet) {
  const ws = encodeURIComponent(worksheet);
  return graph(
    token,
    `/drives/${driveId}/items/${itemId}/workbook/worksheets('${ws}')/usedRange?$select=address,rowCount,columnCount,values,formulas,numberFormat`,
  );
}

async function main() {
  const dump = process.argv.includes('--dump');
  console.log('• Acquiring access token (Microsoft Graph)...');
  const token = await acquireToken();
  console.log('  ✓ token acquired');

  console.log('• Verifying identity (GET /me)...');
  const me = await graph(token, '/me');
  console.log(`  ✓ signed in as ${me.displayName} <${me.userPrincipalName || me.mail || '(no email)'}>`);

  console.log('• Resolving workbook from sharing URL...');
  const item = await resolveWorkbook(token);
  const driveId = item.parentReference?.driveId;
  console.log(`  ✓ ${item.name}`);
  console.log(`    driveItemId : ${item.id}`);
  console.log(`    driveId     : ${driveId}`);
  console.log(`    lastModified: ${item.lastModifiedDateTime}`);
  console.log(`    size        : ${item.size} bytes`);

  console.log(`• Reading used range from worksheet "${WORKSHEET_NAME}"...`);
  const used = await readUsedRange(token, driveId, item.id, WORKSHEET_NAME);
  console.log(`  ✓ range: ${used.address}  (${used.rowCount} rows × ${used.columnCount} cols)`);

  console.log('\nPreview (first 3 rows):');
  for (const row of (used.values || []).slice(0, 3)) {
    console.log('  ', JSON.stringify(row));
  }

  if (dump) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dumpsDir = resolve(process.cwd(), 'dumps');
    await (await import('node:fs/promises')).mkdir(dumpsDir, { recursive: true });
    const path = resolve(dumpsDir, `dump-${ts}.json`);
    const payload = {
      workbook: {
        name: item.name,
        driveId,
        itemId: item.id,
        worksheet: WORKSHEET_NAME,
        lastModifiedDateTime: item.lastModifiedDateTime,
        eTag: item.eTag,
      },
      usedRange: used,
      dumpedAt: new Date().toISOString(),
    };
    await writeFile(path, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`\n✓ Dumped workbook to ${path}`);
  }
}

main().catch((e) => {
  console.error('\n✗ ' + (e?.message || e));
  process.exit(1);
});
