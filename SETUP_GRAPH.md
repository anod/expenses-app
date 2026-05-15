# Setup: Microsoft Graph access to your OneDrive Excel file

You need to register an application with Microsoft Entra (Azure AD) so this code
can sign in to your Microsoft account and read your OneDrive workbook. This is a
one-time, free, ~5-minute task.

## 1. Register the app

1. Open <https://entra.microsoft.com> and sign in with **the same Microsoft
   account that owns the OneDrive file**.
2. In the left nav: **Identity → Applications → App registrations → + New registration**.
3. Fill in:
   - **Name**: `expenses-app` (anything you like).
   - **Supported account types**: choose
     **"Personal Microsoft accounts only"** (since the file is in personal OneDrive).
   - **Redirect URI**: leave blank for now — we use the device-code flow which
     does not need a redirect URI.
4. Click **Register**.
5. On the app's **Overview** page, copy the **Application (client) ID**. Paste
   it into `.env` as `MICROSOFT_CLIENT_ID=...`.

## 2. Allow public-client / device-code flow

1. Open the app → **Authentication** (left nav).
2. Scroll to **Advanced settings → Allow public client flows** and toggle it to **Yes**.
3. Click **Save**.

## 3. Add Graph permissions

1. Open the app → **API permissions**.
2. Click **+ Add a permission → Microsoft Graph → Delegated permissions**.
3. Search for and check:
   - `Files.ReadWrite` (read and write your files)
   - `offline_access` (so we can refresh the token without re-signing-in)
   - `User.Read` (basic profile, useful for the connection test)
4. Click **Add permissions**.
5. Personal accounts grant consent on first sign-in — no admin consent button is needed.

## 4. Fill in `.env`

```env
MICROSOFT_CLIENT_ID=<the GUID from step 1.5>
MICROSOFT_TENANT_ID=consumers
ONEDRIVE_WORKBOOK_URL=<paste the OneDrive sharing URL of your Excel file>
WORKSHEET_NAME=Sheet1
```

`ONEDRIVE_WORKBOOK_URL` is the URL you'd open in the browser to view the file.

## 5. Run the connection test

```bash
npm install
npm run test:connection
```

You'll see something like:

```
To sign in, use a web browser to open https://microsoft.com/devicelogin
and enter the code ABCD-EFGH to authenticate.
```

Open that page in any browser, paste the code, sign in with the OneDrive
account. The terminal will then resolve the workbook and print metadata.

To dump the entire workbook used range to a JSON file:

```bash
npm run dump
```

This writes `dump-<timestamp>.json` in the project root.

## Troubleshooting

- **AADSTS50194 / "not configured as a multi-tenant"**: set
  `MICROSOFT_TENANT_ID=consumers` (not `common`).
- **"Application is not configured for users in this directory"**: under app
  registration → **Authentication**, ensure "Personal Microsoft accounts only"
  or "Personal + work" is selected.
- **Token cache issues**: delete `.token-cache.json` and re-run.
- **403 on workbook read**: ensure the signed-in account is the owner (or has
  edit access) of the file pointed to by `ONEDRIVE_WORKBOOK_URL`.
