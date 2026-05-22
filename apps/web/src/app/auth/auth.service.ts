import { Injectable, computed, signal } from '@angular/core';
import {
  type AccountInfo,
  type AuthenticationResult,
  BrowserAuthError,
  InteractionRequiredAuthError,
  PublicClientApplication,
} from '@azure/msal-browser';
import type { ApiConfig, AuthConfig } from './api-config';

type TokenKind = 'api' | 'graph';

const STALE_REDIRECT_CACHE_ERROR = 'no_token_request_cache_error';
const RECOVERABLE_BROWSER_AUTH_ERRORS = new Set([
  'monitor_window_timeout',
  'monitor_popup_timeout',
  'timed_out',
]);

function isRecoverableBrowserAuthError(err: unknown): boolean {
  return err instanceof BrowserAuthError && RECOVERABLE_BROWSER_AUTH_ERRORS.has(err.errorCode);
}

function isStaleRedirectCacheError(err: unknown): boolean {
  return err instanceof BrowserAuthError && err.errorCode === STALE_REDIRECT_CACHE_ERROR;
}

function clearAuthResponseFromUrl(): void {
  const url = new URL(window.location.href);
  const authParams = ['code', 'state', 'session_state', 'error', 'error_description', 'client_info'];
  let changed = false;

  for (const param of authParams) {
    if (url.searchParams.has(param)) {
      url.searchParams.delete(param);
      changed = true;
    }
  }

  if (/(^|[#&?])(code|state|error|error_description|session_state)=/.test(url.hash)) {
    url.hash = '';
    changed = true;
  }

  if (changed) {
    window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
  }
}

/**
 * Wraps MSAL.js for the personal-use case:
 * - One PublicClientApplication, initialized once at bootstrap via initialize().
 * - Signal-based account state for templates.
 * - getApiToken() / getGraphToken() each do silent → redirect fallback so
 *   callers (e.g. HTTP interceptor) can `await` a token without juggling
 *   MSAL exceptions themselves. Each token has its own scope list and
 *   `aud` claim, so we never reuse a Graph token to call the API.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private pca: PublicClientApplication | null = null;
  private auth: AuthConfig | null = null;
  private readonly inFlight: Record<TokenKind, Promise<string | null> | null> = {
    api: null,
    graph: null,
  };
  private readonly inFlightRefresh: Record<TokenKind, Promise<string | null> | null> = {
    api: null,
    graph: null,
  };

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
    let result: AuthenticationResult | null = null;
    try {
      result = await this.pca.handleRedirectPromise();
    } catch (err) {
      if (!isStaleRedirectCacheError(err)) throw err;
      clearAuthResponseFromUrl();
    }
    if (result?.account) {
      this.pca.setActiveAccount(result.account);
      clearAuthResponseFromUrl();
    }
    const active = this.pca.getActiveAccount() ?? this.pca.getAllAccounts()[0] ?? null;
    if (active) this.pca.setActiveAccount(active);
    this._account.set(active);
  }

  async signIn(): Promise<void> {
    const pca = this.requirePca();
    // Microsoft Entra requires a single resource per token request:
    // mixing Graph scopes (Files.ReadWrite/User.Read) with our API scope
    // (api://<clientId>/access) in one `scopes` list returns AADSTS70011.
    // Workaround: request Graph as the primary resource and consent to
    // the API scope via `extraScopesToConsent`. After login, the SPA
    // acquires each token separately with its own resource scope list.
    console.log(
      '[auth] loginRedirect() starting, graph=', this.auth!.graphScopes,
      'extra=', this.auth!.apiScopes,
    );
    await pca.loginRedirect({
      scopes: this.auth!.graphScopes,
      extraScopesToConsent: this.auth!.apiScopes,
    });
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

  /** Silent → redirect fallback. Returns null if the user is not signed in. */
  getApiToken(): Promise<string | null> {
    return this.getToken('api');
  }

  /** Silent → redirect fallback. Returns null if the user is not signed in. */
  getGraphToken(): Promise<string | null> {
    return this.getToken('graph');
  }

  /** Force a fresh token (e.g. after a 401). Deduplicated across callers. */
  refreshApiToken(): Promise<string | null> {
    return this.refresh('api');
  }

  refreshGraphToken(): Promise<string | null> {
    return this.refresh('graph');
  }

  /** Marks an init failure so the UI can show a visible error banner. */
  setInitError(message: string | null): void {
    this._initError.set(message);
  }

  private async getToken(kind: TokenKind): Promise<string | null> {
    if (!this.pca || !this.auth) return null;
    if (this.inFlight[kind]) return this.inFlight[kind]!;
    const promise = this.acquireToken(kind);
    this.inFlight[kind] = promise;
    try {
      return await promise;
    } finally {
      this.inFlight[kind] = null;
    }
  }

  private async refresh(kind: TokenKind): Promise<string | null> {
    if (!this.pca || !this.auth) return null;
    if (this.inFlightRefresh[kind]) return this.inFlightRefresh[kind]!;
    const promise = this.doRefresh(kind);
    this.inFlightRefresh[kind] = promise;
    try {
      return await promise;
    } finally {
      this.inFlightRefresh[kind] = null;
    }
  }

  private scopesFor(kind: TokenKind): string[] {
    return kind === 'api' ? this.auth!.apiScopes : this.auth!.graphScopes;
  }

  private async doRefresh(kind: TokenKind): Promise<string | null> {
    const account = this.pca!.getActiveAccount();
    if (!account) return null;
    try {
      const result = await this.pca!.acquireTokenSilent({
        account,
        scopes: this.scopesFor(kind),
        forceRefresh: true,
      });
      return this.handleResult(result);
    } catch {
      return this.redirectFallback(kind);
    }
  }

  private async acquireToken(kind: TokenKind): Promise<string | null> {
    const pca = this.pca!;
    const account = pca.getActiveAccount();
    if (!account) return null;
    try {
      const result = await pca.acquireTokenSilent({
        account,
        scopes: this.scopesFor(kind),
      });
      return this.handleResult(result);
    } catch (err) {
      if (err instanceof InteractionRequiredAuthError || isRecoverableBrowserAuthError(err)) {
        return this.redirectFallback(kind);
      }
      throw err;
    }
  }

  private async redirectFallback(kind: TokenKind): Promise<string | null> {
    const pca = this.requirePca();
    await pca.acquireTokenRedirect({ scopes: this.scopesFor(kind) });
    return null;
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
