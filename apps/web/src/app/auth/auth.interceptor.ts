import { HttpErrorResponse, type HttpInterceptorFn, type HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { from, switchMap, catchError, throwError, forkJoin, of } from 'rxjs';
import { AuthService } from './auth.service';

/**
 * Paths that need a Graph passthrough token sent in `X-MS-Graph-Token`.
 * The API uses this header (not the Authorization Bearer) to call
 * Microsoft Graph on the user's behalf. We use prefix matching so query
 * strings and resource ids (e.g. `/api/ledger/<id>`) still match.
 */
const GRAPH_PASSTHROUGH_PREFIXES: ReadonlyArray<string> = [
  '/api/expenses',
  '/api/workbook/',
  '/api/import/',
  '/api/sync/',
];

function needsGraphToken(url: string): boolean {
  return (
    GRAPH_PASSTHROUGH_PREFIXES.some((p) => url.startsWith(p)) ||
    url === '/api/esop' ||
    url.startsWith('/api/esop?') ||
    url.startsWith('/api/esop/status')
  );
}

function applyHeaders(
  req: HttpRequest<unknown>,
  apiToken: string | null,
  graphToken: string | null,
): HttpRequest<unknown> {
  const headers: Record<string, string> = {};
  if (apiToken) headers['Authorization'] = `Bearer ${apiToken}`;
  if (graphToken && needsGraphToken(req.url)) headers['X-MS-Graph-Token'] = graphToken;
  return Object.keys(headers).length > 0 ? req.clone({ setHeaders: headers }) : req;
}

/**
 * Attaches Authorization: Bearer (API audience token) to /api/* requests
 * and, for Graph-passthrough routes, also X-MS-Graph-Token. On 401,
 * forces a refresh of the API token (the most likely cause) and retries
 * once.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith('/api/') || req.url === '/api/config') {
    return next(req);
  }
  const auth = inject(AuthService);
  if (!auth.enabled()) {
    return next(req);
  }

  const wantsGraph = needsGraphToken(req.url);
  const tokens$ = forkJoin({
    api: from(auth.getApiToken()),
    graph: wantsGraph ? from(auth.getGraphToken()) : of(null),
  });

  return tokens$.pipe(
    switchMap(({ api, graph }) => {
      const authed = applyHeaders(req, api, graph);
      return next(authed).pipe(
        catchError((err: unknown) => {
          if (err instanceof HttpErrorResponse && err.status === 401 && api) {
            return from(auth.refreshApiToken()).pipe(
              switchMap((freshApi) => {
                if (!freshApi) return throwError(() => err);
                const retried = applyHeaders(req, freshApi, graph);
                return next(retried);
              }),
            );
          }
          return throwError(() => err);
        }),
      );
    }),
  );
};
