export interface AuthConfig {
  clientId: string;
  authority: string;
  /**
   * Deprecated: union of API + Graph scopes. Kept on the wire only for
   * backward compatibility; the SPA no longer uses it because Microsoft
   * Entra rejects multi-resource token requests (AADSTS70011). Login
   * now passes `graphScopes` as `scopes` and `apiScopes` as
   * `extraScopesToConsent`.
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
   * (e.g. /api/workbook/*, /api/backup/*).
   */
  graphScopes: string[];
}

export interface ApiConfig {
  source: 'graph' | 'dump' | 'demo';
  auth: AuthConfig | null;
  demo?: boolean;
}
