import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { HttpClient, provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { authInterceptor } from './auth/auth.interceptor';
import { AuthService } from './auth/auth.service';
import type { ApiConfig } from './auth/api-config';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideHttpClient(withFetch(), withInterceptors([authInterceptor])),
    provideAppInitializer(async () => {
      const http = inject(HttpClient);
      const auth = inject(AuthService);
      try {
        const config = await firstValueFrom(http.get<ApiConfig>('/api/config'));
        await auth.initialize(config);
      } catch (err) {
        console.error('Failed to initialize auth from /api/config', err);
      }
    }),
  ],
};
