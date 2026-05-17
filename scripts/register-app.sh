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

# Add SPA platform redirect URIs for browser auth-code + PKCE (used by the web app).
# Both localhost and 127.0.0.1 are registered so MSAL doesn't 400 on whichever
# one the user opens in the browser.
SPA_REDIRECT_URIS=("${SPA_REDIRECT_URI:-http://localhost:4200}" "http://127.0.0.1:4200")
echo "• Ensuring SPA redirect URIs ${SPA_REDIRECT_URIS[*]}..."
EXISTING_SPA_JSON=$(az ad app show --id "$APP_ID" --query 'spa.redirectUris' -o json 2>/dev/null || echo '[]')
NEEDS_UPDATE=0
for URI in "${SPA_REDIRECT_URIS[@]}"; do
  if ! echo "$EXISTING_SPA_JSON" | grep -q "\"$URI\""; then
    NEEDS_UPDATE=1
  fi
done
if [[ "$NEEDS_UPDATE" -eq 0 ]]; then
  echo "  ✓ already configured"
else
  SPA_URIS_CSV="$(IFS=,; echo "${SPA_REDIRECT_URIS[*]}")"
  MERGED=$(echo "$EXISTING_SPA_JSON" | SPA_URIS="$SPA_URIS_CSV" python3 -c "
import json, sys, os
existing = json.load(sys.stdin) or []
for uri in os.environ['SPA_URIS'].split(','):
    if uri and uri not in existing:
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
  echo "  ✓ added SPA redirect URI(s)"
fi

echo
echo "================================================================"
echo " Application (client) ID: $APP_ID"
echo "================================================================"

# -----------------------------------------------------------------------------
# Expose `api://<clientId>/access` as a custom API scope and pre-authorize the
# SPA (this same app registration) to call it silently. The API audience for
# server-side Bearer validation is `api://<clientId>` — distinct from the Graph
# token. See docs/deploy.md "Auth model" for details.
# -----------------------------------------------------------------------------
APP_OBJECT_ID=$(az ad app show --id "$APP_ID" --query id -o tsv)
IDENTIFIER_URI="api://$APP_ID"
SCOPE_ID=$(az ad app show --id "$APP_ID" --query "api.oauth2PermissionScopes[?value=='access'].id | [0]" -o tsv 2>/dev/null || true)

if [[ -z "$SCOPE_ID" ]]; then
  echo "• Exposing API scope 'access' (api://$APP_ID/access)..."
  SCOPE_ID=$(uuidgen | tr 'A-Z' 'a-z')
  # Microsoft Graph rejects creating the scope and the
  # preAuthorizedApplications entry in one PATCH (the scope id isn't yet
  # known to the AppPermissions set at validation time). Do it in two
  # PATCHes: first register the scope + identifier URI, then add the
  # SPA pre-authorization referencing the now-existent scope id.
  SCOPE_BODY=$(SCOPE_ID="$SCOPE_ID" APP_ID="$APP_ID" python3 -c "
import json, os
body = {
  'identifierUris': ['api://' + os.environ['APP_ID']],
  'api': {
    'requestedAccessTokenVersion': 2,
    'oauth2PermissionScopes': [{
      'id': os.environ['SCOPE_ID'],
      'adminConsentDescription': 'Allow the application to call the expenses API on behalf of the signed-in user.',
      'adminConsentDisplayName': 'Access expenses API',
      'userConsentDescription': 'Allow the app to access the expenses API on your behalf.',
      'userConsentDisplayName': 'Access expenses API',
      'value': 'access',
      'type': 'User',
      'isEnabled': True,
    }],
  },
}
print(json.dumps(body))
")
  TMP=$(mktemp)
  echo "$SCOPE_BODY" > "$TMP"
  az rest --method PATCH \
    --uri "https://graph.microsoft.com/v1.0/applications/$APP_OBJECT_ID" \
    --headers "Content-Type=application/json" \
    --body "@$TMP" >/dev/null
  rm -f "$TMP"

  PREAUTH_BODY=$(SCOPE_ID="$SCOPE_ID" APP_ID="$APP_ID" python3 -c "
import json, os
body = {
  'api': {
    'preAuthorizedApplications': [{
      'appId': os.environ['APP_ID'],
      'delegatedPermissionIds': [os.environ['SCOPE_ID']],
    }],
  },
}
print(json.dumps(body))
")
  TMP=$(mktemp)
  echo "$PREAUTH_BODY" > "$TMP"
  az rest --method PATCH \
    --uri "https://graph.microsoft.com/v1.0/applications/$APP_OBJECT_ID" \
    --headers "Content-Type=application/json" \
    --body "@$TMP" >/dev/null
  rm -f "$TMP"
  echo "  ✓ scope exposed and SPA pre-authorized"
else
  echo "  ✓ API scope 'access' already exposed ($SCOPE_ID)"
fi
echo "  ✓ Identifier URI: $IDENTIFIER_URI"

# -----------------------------------------------------------------------------
# Print the signed-in user's Microsoft `oid`. This is the single piece of
# data the server needs in ALLOWED_OIDS to bind the API to a specific account
# when REQUIRE_AUTH=true.
# -----------------------------------------------------------------------------
echo "• Looking up signed-in user's Microsoft oid..."
USER_OID=$(az ad signed-in-user show --query id -o tsv 2>/dev/null || true)
if [[ -n "$USER_OID" ]]; then
  echo "  ✓ Your oid: $USER_OID"
else
  echo "  ! Could not fetch oid via 'az ad signed-in-user show'."
  echo "    For personal MSAs, sign in to https://jwt.ms with the SPA once and"
  echo "    copy the 'oid' claim from the decoded token."
fi

echo
echo "Writing MICROSOFT_CLIENT_ID into .env..."
if grep -q '^MICROSOFT_CLIENT_ID=' .env 2>/dev/null; then
  sed -i.bak "s|^MICROSOFT_CLIENT_ID=.*|MICROSOFT_CLIENT_ID=$APP_ID|" .env && rm -f .env.bak
else
  echo "MICROSOFT_CLIENT_ID=$APP_ID" >> .env
fi
echo "  ✓ .env updated"

if [[ -n "$USER_OID" ]]; then
  if grep -q '^ALLOWED_OIDS=' .env 2>/dev/null; then
    if ! grep -q "^ALLOWED_OIDS=.*$USER_OID" .env; then
      echo "  ! ALLOWED_OIDS in .env does not include $USER_OID — leaving as-is."
    fi
  else
    echo "ALLOWED_OIDS=$USER_OID" >> .env
    echo "  ✓ ALLOWED_OIDS=$USER_OID written to .env"
  fi
fi

echo
echo "Next:  docker compose run --rm graph-tester  # to populate dumps"
echo "       npm run dev                           # to start the web app at ${SPA_REDIRECT_URIS[0]}"
