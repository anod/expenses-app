#!/usr/bin/env bash
# Register the Microsoft Entra app for the expenses tester via Azure CLI.
# NOTE: works most reliably when signed into a work/school tenant. For a pure
# personal Microsoft account, this may fail and you should use the portal
# (see SETUP_GRAPH.md). If it fails, the script tells you so.
#
# Prereq:
#   az login --allow-no-subscriptions
set -euo pipefail

APP_NAME="${APP_NAME:-expenses-app}"
# PersonalMicrosoftAccount → only personal MSAs can sign in (matches OneDrive personal).
# Use AzureADandPersonalMicrosoftAccount if you also want work accounts.
AUDIENCE="${AUDIENCE:-PersonalMicrosoftAccount}"

# Microsoft Graph service principal app id (constant across all tenants)
GRAPH_APP_ID="00000003-0000-0000-c000-000000000000"

# Delegated permission IDs in Microsoft Graph (constant)
PERM_FILES_READWRITE="863451e7-0667-486c-a5d6-d135439485f0"   # Files.ReadWrite
PERM_OFFLINE_ACCESS="7427e0e9-2fba-42fe-b0c0-848c9e6a8182"   # offline_access
PERM_USER_READ="e1fe6dd8-ba31-4d61-89e7-88639da4683d"        # User.Read

echo "• Checking az login..."
if ! az account show >/dev/null 2>&1; then
  echo "  ✗ Not logged in. Run: az login --allow-no-subscriptions"
  exit 1
fi
WHOAMI=$(az account show --query user.name -o tsv)
echo "  ✓ signed in as $WHOAMI"

echo "• Looking for existing app named '$APP_NAME'..."
APP_ID=$(az ad app list --display-name "$APP_NAME" --query '[0].appId' -o tsv 2>/dev/null || true)

if [[ -z "$APP_ID" ]]; then
  echo "• Creating app registration..."
  APP_ID=$(az ad app create \
    --display-name "$APP_NAME" \
    --sign-in-audience "$AUDIENCE" \
    --is-fallback-public-client true \
    --query appId -o tsv)
  echo "  ✓ created app: $APP_ID"
else
  echo "  ✓ already exists: $APP_ID"
  echo "• Ensuring public-client flow enabled..."
  az ad app update --id "$APP_ID" --is-fallback-public-client true >/dev/null
fi

echo "• Adding Microsoft Graph delegated permissions..."
for PERM in "$PERM_FILES_READWRITE" "$PERM_OFFLINE_ACCESS" "$PERM_USER_READ"; do
  az ad app permission add \
    --id "$APP_ID" \
    --api "$GRAPH_APP_ID" \
    --api-permissions "${PERM}=Scope" \
    >/dev/null 2>&1 || true
done
echo "  ✓ permissions added (consent happens at first sign-in for personal accounts)"

# Add SPA platform redirect URI for browser auth-code + PKCE (used by the web app)
SPA_REDIRECT_URI="${SPA_REDIRECT_URI:-http://localhost:4200}"
echo "• Ensuring SPA redirect URI '$SPA_REDIRECT_URI'..."
EXISTING_SPA_JSON=$(az ad app show --id "$APP_ID" --query 'spa.redirectUris' -o json 2>/dev/null || echo '[]')
if echo "$EXISTING_SPA_JSON" | grep -q "\"$SPA_REDIRECT_URI\""; then
  echo "  ✓ already configured"
else
  # Merge with any existing SPA URIs.
  MERGED=$(echo "$EXISTING_SPA_JSON" | python3 -c "
import json, sys
existing = json.load(sys.stdin) or []
uri = '$SPA_REDIRECT_URI'
if uri not in existing:
    existing.append(uri)
print(json.dumps({'spa': {'redirectUris': existing}}))
")
  TMP=$(mktemp)
  echo "$MERGED" > "$TMP"
  APP_OBJECT_ID=$(az ad app show --id "$APP_ID" --query id -o tsv)
  az rest --method PATCH \
    --uri "https://graph.microsoft.com/v1.0/applications/$APP_OBJECT_ID" \
    --headers "Content-Type=application/json" \
    --body "@$TMP" >/dev/null
  rm -f "$TMP"
  echo "  ✓ added SPA redirect URI"
fi

echo
echo "================================================================"
echo " Application (client) ID: $APP_ID"
echo "================================================================"
echo
echo "Writing MICROSOFT_CLIENT_ID into .env..."
if grep -q '^MICROSOFT_CLIENT_ID=' .env 2>/dev/null; then
  sed -i.bak "s|^MICROSOFT_CLIENT_ID=.*|MICROSOFT_CLIENT_ID=$APP_ID|" .env && rm -f .env.bak
else
  echo "MICROSOFT_CLIENT_ID=$APP_ID" >> .env
fi
echo "  ✓ .env updated"

echo
echo "Next:  docker compose run --rm graph-tester  # to populate dumps"
echo "       npm run dev                           # to start the web app at $SPA_REDIRECT_URI"
