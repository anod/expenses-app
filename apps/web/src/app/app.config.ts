import {
  ApplicationConfig,
  inject,
  isDevMode,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { HttpClient, provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { firstValueFrom } from 'rxjs';
import { authInterceptor } from './auth/auth.interceptor';
import { AuthService } from './auth/auth.service';
import type { ApiConfig } from './auth/api-config';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideHttpClient(withFetch(), withInterceptors([authInterceptor])),
    provideRouter(routes, withComponentInputBinding()),
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
    provideAppInitializer(async () => {
      const http = inject(HttpClient);
      const auth = inject(AuthService);
      try {
        const config = await firstValueFrom(http.get<ApiConfig>('/api/config'));
        await auth.initialize(config);
      } catch (err) {
        const message =
          err && typeof err === 'object' && 'message' in err
            ? String((err as { message: unknown }).message)
            : 'Unable to reach the API';
        console.error('Failed to initialize auth from /api/config', err);
        auth.setInitError(`Failed to load app config: ${message}`);
      }
    }),
  ],
};
