import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z, ZodError } from 'zod';
import {
  occurrenceKeyOf,
  todayInZone,
  type LedgerEntry,
  type RecurringTemplate,
} from '@expenses/shared';
import type { StateRepo } from '../db/stateRepo.js';
import { computeForecast } from './computeForecast.js';
import {
  AccountInput,
  CreditCardInput,
  LedgerEntryInput,
  RecurringInput,
  SettingsInput,
} from './schemas.js';

const handleZod = (err: unknown, res: import('express').Response): boolean => {
  if (err instanceof ZodError) {
    res
      .status(400)
      .json({ error: 'VALIDATION', issues: err.issues });
    return true;
  }
  return false;
};

const validateNoFutureAsOf = (asOf: string, today: string, what: string): void => {
  if (asOf > today) {
    const err = new Error(`${what} asOf must not be in the future (got ${asOf}, today=${today})`);
    (err as Error & { status?: number }).status = 400;
    throw err;
  }
};

/**
 * Builds the mutation routes. Each mutation returns the fresh ForecastResult
 * as a piggy-back so the client only needs one round-trip.
 */
export const buildForecastRoutes = (getRepo: () => StateRepo): Router => {
  const router = Router();

  const today = (): string => todayInZone(getRepo().getSettings().timezone);

  const withForecast = <T>(res: import('express').Response, payload: T): void => {
    res.json({ entity: payload, forecast: computeForecast(getRepo()) });
  };

  // --- account
  router.get('/account', (_req, res) => res.json(getRepo().getAccount()));
  router.patch('/account', (req, res) => {
    try {
      const input = AccountInput.parse(req.body);
      validateNoFutureAsOf(input.asOf, today(), 'account');
      getRepo().upsertAccount(input);
      withForecast(res, getRepo().getAccount());
    } catch (err) {
      if (!handleZod(err, res)) throw err;
    }
  });

  // --- cards
  router.get('/cards', (_req, res) => res.json(getRepo().listCards()));
  router.post('/cards', (req, res) => {
    try {
      const input = CreditCardInput.parse(req.body);
      validateNoFutureAsOf(input.asOf, today(), 'card');
      // User-created cards are NOT excel_owned; the importer must not
      // wipe them on re-import.
      const card = { ...input, id: input.id ?? randomUUID(), excelOwned: false };
      getRepo().upsertCard(card);
      withForecast(res, card);
    } catch (err) {
      if (!handleZod(err, res)) throw err;
    }
  });
  router.patch('/cards/:id', (req, res) => {
    try {
      const input = CreditCardInput.parse({ ...req.body, id: req.params.id });
      validateNoFutureAsOf(input.asOf, today(), 'card');
      // Preserve excelOwned across PATCH so editing a card's debit/name
      // doesn't accidentally "claim" it on either side of the boundary.
      const existing = getRepo().listCards().find((c) => c.id === req.params.id);
      getRepo().upsertCard({
        ...input,
        id: req.params.id,
        excelOwned: existing?.excelOwned ?? false,
      });
      withForecast(res, getRepo().listCards().find((c) => c.id === req.params.id) ?? null);
    } catch (err) {
      if (!handleZod(err, res)) throw err;
    }
  });
  router.delete('/cards/:id', (req, res) => {
    getRepo().deleteCard(req.params.id);
    res.json({ forecast: computeForecast(getRepo()) });
  });

  // --- ledger
  router.get('/ledger', (_req, res) => res.json(getRepo().listLedger()));
  router.post('/ledger', (req, res) => {
    try {
      const input = LedgerEntryInput.parse(req.body);
      const entry: LedgerEntry = {
        id: input.id ?? randomUUID(),
        description: input.description,
        amount: input.amount,
        channel: input.channel as LedgerEntry['channel'],
        date: input.date,
        status: input.status,
        ...(input.recurringId != null ? { recurringId: input.recurringId } : {}),
        ...(input.occurrenceKey != null ? { occurrenceKey: input.occurrenceKey } : {}),
      };
      getRepo().upsertLedger(entry);
      withForecast(res, entry);
    } catch (err) {
      if (!handleZod(err, res)) throw err;
    }
  });
  router.patch('/ledger/:id', (req, res) => {
    try {
      const input = LedgerEntryInput.parse({ ...req.body, id: req.params.id });
      const entry: LedgerEntry = {
        id: req.params.id,
        description: input.description,
        amount: input.amount,
        channel: input.channel as LedgerEntry['channel'],
        date: input.date,
        status: input.status,
        ...(input.recurringId != null ? { recurringId: input.recurringId } : {}),
        ...(input.occurrenceKey != null ? { occurrenceKey: input.occurrenceKey } : {}),
      };
      getRepo().upsertLedger(entry);
      withForecast(res, entry);
    } catch (err) {
      if (!handleZod(err, res)) throw err;
    }
  });
  router.post('/ledger/:id/clear', (req, res) => {
    const id = req.params.id;

    // Persisted ledger row: flip status to cleared.
    const all = getRepo().listLedger();
    const found = all.find((e) => e.id === id);
    if (found) {
      const cleared: LedgerEntry = { ...found, status: 'cleared' };
      getRepo().upsertLedger(cleared);
      withForecast(res, cleared);
      return;
    }

    // Virtual recurring occurrence: materialize a cleared override.
    // Virtual IDs are `virtual:<recurringId>:<isoDate>` — derive the template
    // and date, then create a persisted ledger row that mergeWithOverrides()
    // will pick up via `occurrenceKey` and which will hide the virtual from
    // future forecasts.
    const virtualMatch = /^virtual:(.+):(\d{4}-\d{2}-\d{2})$/.exec(id);
    if (virtualMatch) {
      const recurringId = virtualMatch[1]!;
      const date = virtualMatch[2]!;
      const template = getRepo()
        .listRecurring()
        .find((t: RecurringTemplate) => t.id === recurringId);
      if (!template) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'recurring template missing' });
        return;
      }
      const override: LedgerEntry = {
        id: randomUUID(),
        description: template.description,
        amount: template.amount,
        channel: template.channel,
        date,
        status: 'cleared',
        recurringId,
        occurrenceKey: occurrenceKeyOf(recurringId, date),
      };
      getRepo().upsertLedger(override);
      withForecast(res, override);
      return;
    }

    res.status(404).json({ error: 'NOT_FOUND' });
  });
  router.delete('/ledger/:id', (req, res) => {
    getRepo().deleteLedger(req.params.id);
    res.json({ forecast: computeForecast(getRepo()) });
  });

  // --- recurring
  router.get('/recurring', (_req, res) => res.json(getRepo().listRecurring()));
  router.post('/recurring', (req, res) => {
    try {
      const input = RecurringInput.parse(req.body);
      const tmpl: import('@expenses/shared').RecurringTemplate = {
        id: input.id ?? randomUUID(),
        description: input.description,
        amount: input.amount,
        channel: input.channel as import('@expenses/shared').Channel,
        day: input.day,
        startDate: input.startDate,
        monthEndPolicy: input.monthEndPolicy,
        ...(input.endDate != null ? { endDate: input.endDate } : {}),
      };
      getRepo().upsertRecurring(tmpl);
      withForecast(res, tmpl);
    } catch (err) {
      if (!handleZod(err, res)) throw err;
    }
  });
  router.patch('/recurring/:id', (req, res) => {
    try {
      const input = RecurringInput.parse({ ...req.body, id: req.params.id });
      const tmpl: import('@expenses/shared').RecurringTemplate = {
        id: req.params.id,
        description: input.description,
        amount: input.amount,
        channel: input.channel as import('@expenses/shared').Channel,
        day: input.day,
        startDate: input.startDate,
        monthEndPolicy: input.monthEndPolicy,
        ...(input.endDate != null ? { endDate: input.endDate } : {}),
      };
      getRepo().upsertRecurring(tmpl);
      withForecast(res, getRepo().listRecurring().find((t) => t.id === req.params.id) ?? null);
    } catch (err) {
      if (!handleZod(err, res)) throw err;
    }
  });
  router.delete('/recurring/:id', (req, res) => {
    getRepo().deleteRecurring(req.params.id);
    res.json({ forecast: computeForecast(getRepo()) });
  });

  // --- settings
  router.get('/settings', (_req, res) => res.json(getRepo().getSettings()));
  router.patch('/settings', (req, res) => {
    try {
      const input = SettingsInput.parse(req.body);
      const { workbookUrl, ...rest } = input;
      getRepo().upsertSettings(
        workbookUrl && workbookUrl.trim() !== ''
          ? { ...rest, workbookUrl: workbookUrl.trim() }
          : rest,
      );
      withForecast(res, getRepo().getSettings());
    } catch (err) {
      if (!handleZod(err, res)) throw err;
    }
  });

  // --- main forecast
  router.get('/forecast', (_req, res) => {
    res.json(computeForecast(getRepo()));
  });

  return router;
};

// Silence unused import (z is needed for ambient type usage by ZodError above only).
void z;
