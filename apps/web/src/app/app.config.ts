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
import { errorMessage } from './core/api-error';
import { SwUpdaterService } from './core/sw-updater.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideHttpClient(withFetch(), withInterceptors([authInterceptor])),
    provideRouter(routes, withComponentInputBinding()),
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:5000',
    }),
    provideAppInitializer(() => {
      inject(SwUpdaterService).start();
    }),
    provideAppInitializer(async () => {
      const http = inject(HttpClient);
      const auth = inject(AuthService);
      try {
        const config = await firstValueFrom(http.get<ApiConfig>('/api/config'));
        await auth.initialize(config);
      } catch (err) {
        console.error('Failed to initialize auth from /api/config', err);
        auth.setInitError(errorMessage(err, 'Failed to load app config.'));
      }
    }),
  ],
};
