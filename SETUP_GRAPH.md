# Setup: Microsoft Graph access to your OneDrive Excel file

You need a Microsoft Entra (Azure AD) app registration so this code can sign
in to your Microsoft account and read your OneDrive workbook. This is a
one-time, free, ~5-minute task.

## Option A — automated (recommended)

If you have the Azure CLI installed and are signed in (`az login`):

```bash
./scripts/register-app.sh
```

The script creates an app named `expenses-app` (override with `APP_NAME=...`)
configured for personal Microsoft accounts + device-code flow, requests the
required Graph scopes, and writes `MICROSOFT_CLIENT_ID=<guid>` into `.env`.

You'll still need to fill in `ONEDRIVE_WORKBOOK_URL` in `.env` manually
(open the file in OneDrive in your browser and copy the full URL).

## Option B — manual portal steps

1. Open <https://entra.microsoft.com> and sign in with **the same Microsoft
   account that owns the OneDrive file**.
2. **Identity → Applications → App registrations → + New registration**.
3. Fill in:
   - **Name**: `expenses-app` (anything you like).
   - **Supported account types**: **"Personal Microsoft accounts only"**.
   - **Redirect URI**: leave blank (device-code flow doesn't need one).
4. Click **Register**.
5. On the app's **Overview** page, copy the **Application (client) ID**
   into `.env` as `MICROSOFT_CLIENT_ID=<guid>`.
6. **Authentication → Advanced settings → Allow public client flows → Yes → Save**.
7. **API permissions → + Add a permission → Microsoft Graph → Delegated permissions**:
   - `Files.ReadWrite`
   - `offline_access`
   - `User.Read`

   Personal accounts grant consent on first sign-in — no admin consent button
   is needed.
8. **Authentication → + Add a platform → Single-page application** and add
   redirect URI **`http://localhost:4200`**. This is required for the browser
   sign-in flow used by the web app (auth-code + PKCE). The `register-app.sh`
   script does this automatically.

## Fill in `.env`

```env
MICROSOFT_CLIENT_ID=<guid from step 5>
MICROSOFT_TENANT_ID=consumers
ONEDRIVE_WORKBOOK_URL=<paste the OneDrive sharing URL of your Excel file>
WORKSHEET_NAME=Sheet1
```

`ONEDRIVE_WORKBOOK_URL` is the URL you'd open in the browser to view the
file. It contains a sharing capability token — treat it as a secret.

## Run the connection test

```bash
npm install
npm run test:connection
```

Sign in with the device code shown. The token is cached in
`.token-cache.json`; subsequent runs are non-interactive.

## Dump the workbook

```bash
npm run dump
```

Writes `dumps/dump-<ISO-timestamp>.json`.

## Troubleshooting

- **AADSTS50194 / "not configured as multi-tenant"** — set
  `MICROSOFT_TENANT_ID=consumers` (not `common`).
- **"Application is not configured for users in this directory"** — under
  app registration → **Authentication**, ensure "Personal Microsoft accounts
  only" or "Personal + work" is selected.
- **Token cache stuck** — delete `.token-cache.json` and re-run.
- **403 on workbook read** — ensure the signed-in account is the owner (or
  has edit access) of the file pointed to by `ONEDRIVE_WORKBOOK_URL`.
