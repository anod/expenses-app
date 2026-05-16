import { forecast, todayInZone, type ForecastResult } from '@expenses/shared';
import type { StateRepo } from '../db/stateRepo.js';

/** Compose persisted state into a ForecastResult. */
export const computeForecast = (repo: StateRepo): ForecastResult => {
  const settings = repo.getSettings();
  const account = repo.getAccount();
  const cards = repo.listCards();
  const templates = repo.listRecurring();
  const persisted = repo.listLedger();
  const today = todayInZone(settings.timezone);
  return forecast({ templates, persisted, account, cards, settings, today });
};
