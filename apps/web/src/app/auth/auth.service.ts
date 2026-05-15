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

  private readonly _account = signal<AccountInfo | null>(null);
  readonly account = this._account.asReadonly();
  readonly isSignedIn = computed(() => this._account() !== null);
  readonly displayName = computed(() => {
    const a = this._account();
    return a?.name ?? a?.username ?? null;
  });

  /** Disabled when API is in dump mode and returns no auth config. */
  readonly enabled = computed(() => this.auth !== null);

  async initialize(config: ApiConfig): Promise<void> {
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
    }
    const active = this.pca.getActiveAccount() ?? this.pca.getAllAccounts()[0] ?? null;
    if (active) this.pca.setActiveAccount(active);
    this._account.set(active);
  }

  async signIn(): Promise<void> {
    const pca = this.requirePca();
    try {
      const result = await pca.loginPopup({ scopes: this.auth!.scopes });
      pca.setActiveAccount(result.account);
      this._account.set(result.account);
    } catch (err) {
      if (err instanceof BrowserAuthError && err.errorCode === 'user_cancelled') return;
      throw err;
    }
  }

  async signOut(): Promise<void> {
    const pca = this.requirePca();
    const account = pca.getActiveAccount();
    this._account.set(null);
    await pca.logoutPopup({
      ...(account ? { account } : {}),
      mainWindowRedirectUri: window.location.origin,
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

  /** Force a fresh token (e.g. after a 401). */
  async refreshToken(): Promise<string | null> {
    if (!this.pca || !this.auth) return null;
    const account = this.pca.getActiveAccount();
    if (!account) return null;
    try {
      const result = await this.pca.acquireTokenSilent({
        account,
        scopes: this.auth.scopes,
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
      const result = await pca.acquireTokenPopup({ scopes: this.auth!.scopes });
      return this.handleResult(result);
    } catch (err) {
      if (err instanceof BrowserAuthError && err.errorCode === 'user_cancelled') return null;
      throw err;
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
