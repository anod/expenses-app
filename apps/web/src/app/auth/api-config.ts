export interface AuthConfig {
  clientId: string;
  authority: string;
  scopes: string[];
}

export interface ApiConfig {
  source: 'graph' | 'dump';
  auth: AuthConfig | null;
}
