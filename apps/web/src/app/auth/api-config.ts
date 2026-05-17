export interface AuthConfig {
  clientId: string;
  authority: string;
  /**
   * Union of all scopes the SPA requests during initial sign-in
   * (loginRedirect) so the user consents to everything once. Subsequent
   * token acquisitions split into `apiScopes` / `graphScopes` so each
   * token has the right `aud`.
   */
  scopes: string[];
  /**
   * Scopes for the API audience token, attached as
   * `Authorization: Bearer <token>` on /api/* requests. Typically
   * `['api://<clientId>/access']`.
   */
  apiScopes: string[];
  /**
   * Scopes for the Microsoft Graph token, attached as
   * `X-MS-Graph-Token: <token>` on Graph-passthrough routes
   * (e.g. /api/expenses, /api/import/*, /api/sync/*).
   */
  graphScopes: string[];
}

export interface ApiConfig {
  source: 'graph' | 'dump' | 'demo';
  auth: AuthConfig | null;
  demo?: boolean;
}
