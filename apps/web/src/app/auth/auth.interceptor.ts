import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { from, switchMap, catchError, throwError } from 'rxjs';
import { AuthService } from './auth.service';

/**
 * Attaches Authorization: Bearer to /api/* requests when the user is signed in.
 * On 401, attempts a single forced refresh + retry before surfacing the error.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith('/api/') || req.url === '/api/config') {
    return next(req);
  }
  const auth = inject(AuthService);
  if (!auth.enabled()) {
    return next(req);
  }

  return from(auth.getToken()).pipe(
    switchMap((token) => {
      const authed = token
        ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
        : req;
      return next(authed).pipe(
        catchError((err: unknown) => {
          if (err instanceof HttpErrorResponse && err.status === 401 && token) {
            return from(auth.refreshToken()).pipe(
              switchMap((fresh) => {
                if (!fresh) return throwError(() => err);
                const retried = req.clone({
                  setHeaders: { Authorization: `Bearer ${fresh}` },
                });
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
