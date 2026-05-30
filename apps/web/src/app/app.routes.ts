import type { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () =>
      import('./forecast/forecast-home').then((m) => m.ForecastHomeComponent),
  },
  {
    path: 'recurring',
    loadComponent: () =>
      import('./recurring/recurring-page').then((m) => m.RecurringPageComponent),
  },
  {
    path: 'settings',
    loadComponent: () =>
      import('./settings/settings-page').then((m) => m.SettingsPageComponent),
  },
  {
    path: 'esop',
    loadComponent: () =>
      import('./esop/esop-page').then((m) => m.EsopPageComponent),
  },
  { path: '**', redirectTo: '' },
];
