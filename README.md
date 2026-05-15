# Expenses — Microsoft Graph connection tester (Phase 0)

Minimal Dockerized script to verify we can read your OneDrive Excel workbook
through Microsoft Graph and dump the current data.

## One-time setup

1. Register a Microsoft Entra app — see [`SETUP_GRAPH.md`](./SETUP_GRAPH.md).
2. Copy your client ID into `.env` (`MICROSOFT_CLIENT_ID=...`).
3. Confirm `ONEDRIVE_WORKBOOK_URL` and `WORKSHEET_NAME` in `.env` are correct.

## Build the image

```bash
docker compose build
```

## Test the connection (interactive sign-in the first time)

```bash
docker compose run --rm graph-tester
```

You will see something like:

```
==============================================================
To sign in, use a web browser to open https://microsoft.com/devicelogin
and enter the code ABCD-EFGH to authenticate.
==============================================================
```

Open that URL in any browser, paste the code, sign in with the Microsoft
account that owns the OneDrive workbook, and consent to the requested
permissions (Files.ReadWrite, offline_access, User.Read).

The script then prints workbook metadata and a 3-row preview.

The refresh token is cached in `./.token-cache.json` (host-mounted), so
subsequent runs skip the device-code prompt.

## Dump the full used range to JSON

```bash
docker compose run --rm graph-tester node scripts/test-graph-connection.mjs --dump
```

Output is written to `./dumps/dump-<timestamp>.json` on the host.

## Reset auth

```bash
rm .token-cache.json && touch .token-cache.json
```
