import { Injectable, computed, signal } from '@angular/core';
import {
  type AccountInfo,
  type AuthenticationResult,
  BrowserAuthError,
  InteractionRequiredAuthError,
  PublicClientApplication,
} from '@azure/msal-browser';
import type { ApiConfig, AuthConfig } from './api-config';

/**
 * Wraps MSAL.js for the personal-use case:
 * - One PublicClientApplication, initialized once at bootstrap via initialize().
 * - Signal-based account state for templates.
 * - getToken() does silent → popup fallback so callers (e.g. HTTP interceptor)
 *   can `await` a token without juggling MSAL exceptions themselves.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private pca: PublicClientApplication | null = null;
  private auth: AuthConfig | null = null;
  private inFlightToken: Promise<string | null> | null = null;
  private inFlightRefresh: Promise<string | null> | null = null;

  private readonly _account = signal<AccountInfo | null>(null);
  private readonly _initError = signal<string | null>(null);
  readonly account = this._account.asReadonly();
  readonly initError = this._initError.asReadonly();
  readonly isSignedIn = computed(() => this._account() !== null);
  readonly displayName = computed(() => {
    const a = this._account();
    return a?.name ?? a?.username ?? null;
  });

  /** Disabled when API is in dump mode and returns no auth config. */
  readonly enabled = computed(() => this.auth !== null);

  private readonly _source = signal<ApiConfig['source']>('dump');
  readonly source = this._source.asReadonly();
  readonly isDemo = computed(() => this._source() === 'demo');

  async initialize(config: ApiConfig): Promise<void> {
    this._source.set(config.source);
    if (config.source !== 'graph' || !config.auth) {
      return;
    }
    this.auth = config.auth;
    this.pca = new PublicClientApplication({
      auth: {
        clientId: config.auth.clientId,
        authority: config.auth.authority,
        redirectUri: window.location.origin,
        postLogoutRedirectUri: window.location.origin,
      },
      cache: {
        cacheLocation: 'sessionStorage',
      },
    });
    await this.pca.initialize();
    const result = await this.pca.handleRedirectPromise();
    if (result?.account) {
      this.pca.setActiveAccount(result.account);
      // Strip the auth code/state from the URL so refreshes don't replay it.
      // Preserve the path and fragment; only the query string carries the
      // auth response.
      window.history.replaceState(
        {},
        document.title,
        window.location.pathname + window.location.hash,
      );
    }
    const active = this.pca.getActiveAccount() ?? this.pca.getAllAccounts()[0] ?? null;
    if (active) this.pca.setActiveAccount(active);
    this._account.set(active);
  }

  async signIn(): Promise<void> {
    const pca = this.requirePca();
    console.log('[auth] loginRedirect() starting, scopes=', this.auth!.scopes);
    await pca.loginRedirect({ scopes: this.auth!.scopes });
    // Page navigates away here; nothing after this line runs.
  }

  async signOut(): Promise<void> {
    const pca = this.requirePca();
    const account = pca.getActiveAccount();
    this._account.set(null);
    await pca.logoutRedirect({
      ...(account ? { account } : {}),
      postLogoutRedirectUri: window.location.origin,
    });
  }

  /** Silent → popup fallback. Returns null if the user is not signed in. */
  async getToken(): Promise<string | null> {
    if (!this.pca || !this.auth) return null;
    if (this.inFlightToken) return this.inFlightToken;
    const promise = this.acquireToken();
    this.inFlightToken = promise;
    try {
      return await promise;
    } finally {
      this.inFlightToken = null;
    }
  }

  /** Marks an init failure so the UI can show a visible error banner. */
  setInitError(message: string | null): void {
    this._initError.set(message);
  }

  /** Force a fresh token (e.g. after a 401). Deduplicated across callers. */
  async refreshToken(): Promise<string | null> {
    if (!this.pca || !this.auth) return null;
    if (this.inFlightRefresh) return this.inFlightRefresh;
    const promise = this.doRefresh();
    this.inFlightRefresh = promise;
    try {
      return await promise;
    } finally {
      this.inFlightRefresh = null;
    }
  }

  private async doRefresh(): Promise<string | null> {
    const account = this.pca!.getActiveAccount();
    if (!account) return null;
    try {
      const result = await this.pca!.acquireTokenSilent({
        account,
        scopes: this.auth!.scopes,
        forceRefresh: true,
      });
      return this.handleResult(result);
    } catch {
      return this.popupFallback();
    }
  }

  private async acquireToken(): Promise<string | null> {
    const pca = this.pca!;
    const account = pca.getActiveAccount();
    if (!account) return null;
    try {
      const result = await pca.acquireTokenSilent({
        account,
        scopes: this.auth!.scopes,
      });
      return this.handleResult(result);
    } catch (err) {
      if (err instanceof InteractionRequiredAuthError) {
        return this.popupFallback();
      }
      throw err;
    }
  }

  private async popupFallback(): Promise<string | null> {
    const pca = this.requirePca();
    try {
      // Used only for token re-acquisition after the user is already
      // signed in (e.g. expired token). Initial login uses redirect.
      const result = await pca.acquireTokenPopup({ scopes: this.auth!.scopes });
      return this.handleResult(result);
    } catch (err) {
      if (err instanceof BrowserAuthError && err.errorCode === 'user_cancelled') return null;
      // If popup is blocked, fall back to a full redirect.
      await pca.acquireTokenRedirect({ scopes: this.auth!.scopes });
      return null;
    }
  }

  private handleResult(result: AuthenticationResult): string {
    if (result.account) {
      this.pca!.setActiveAccount(result.account);
      this._account.set(result.account);
    }
    return result.accessToken;
  }

  private requirePca(): PublicClientApplication {
    if (!this.pca) {
      throw new Error('AuthService not initialized — auth is disabled (API in dump mode)');
    }
    return this.pca;
  }
}
