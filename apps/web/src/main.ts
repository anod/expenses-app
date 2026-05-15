import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

/**
 * If we were opened by MSAL as a popup/redirect callback, the URL contains
 * `code=` and `state=` query params. In that case we DON'T want to bootstrap
 * the full app — we just need MSAL to process the response and close the
 * window. Loading Angular + fetching /api/config first races with the
 * popup-close handshake and leaves the popup stranded showing the app UI.
 */
function isMsalCallback(): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.has('code') && params.has('state')) return true;
  if (params.has('error') && params.has('state')) return true;
  // Hash-mode (legacy implicit) just in case
  if (window.location.hash.includes('code=') || window.location.hash.includes('error=')) {
    return true;
  }
  return false;
}

async function handleAuthCallback(): Promise<void> {
  // Lazy-import so we only pay the MSAL bundle cost in the popup window.
  const { PublicClientApplication } = await import('@azure/msal-browser');
  const res = await fetch('/api/config');
  const config = await res.json();
  if (!config?.auth) return;
  const pca = new PublicClientApplication({
    auth: {
      clientId: config.auth.clientId,
      authority: config.auth.authority,
      redirectUri: window.location.origin,
    },
    cache: { cacheLocation: 'sessionStorage' },
  });
  await pca.initialize();
  // handleRedirectPromise will detect we're in a popup and message the
  // opener + close the window automatically.
  await pca.handleRedirectPromise();
}

if (isMsalCallback() && window.opener && window.opener !== window) {
  handleAuthCallback().catch((err) => {
    console.error('MSAL callback handling failed', err);
  });
} else {
  bootstrapApplication(App, appConfig).catch((err) => console.error(err));
}
