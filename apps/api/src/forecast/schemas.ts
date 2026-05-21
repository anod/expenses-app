import { z } from 'zod';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

const channel = z
  .string()
  .regex(/^(bank|cc:.+)$/, 'channel must be "bank" or "cc:<cardId>"');

export const AccountInput = z.object({
  bankBalance: z.number().finite(),
  asOf: isoDate,
});

export const CreditCardInput = z.object({
  id: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(64),
  currentDebit: z.number().nonnegative().finite(),
  asOf: isoDate,
  billingDayOfMonth: z.number().int().min(1).max(31),
  mode: z.enum(['credit', 'debit']).optional(),
});

const cadenceInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('monthly'),
    day: z.number().int().min(1).max(31),
    monthEndPolicy: z.literal('clamp').default('clamp'),
  }),
  z.object({
    kind: z.literal('weekly'),
    dayOfWeek: z.number().int().min(0).max(6),
  }),
  z.object({
    kind: z.literal('monthly_prediction'),
  }),
]);

export const RecurringInput = z
  .object({
    id: z.string().min(1).max(64).optional(),
    description: z.string().min(1).max(200),
    amount: z.number().finite(),
    channel,
    startDate: isoDate,
    endDate: isoDate.optional(),
    // Either the new discriminated shape OR the legacy flat shape
    // (kept for backwards-compat with older web clients that send
    // top-level day + monthEndPolicy and don't know about cadence).
    cadence: cadenceInput.optional(),
    day: z.number().int().min(1).max(31).optional(),
    monthEndPolicy: z.literal('clamp').default('clamp'),
  })
  .refine(
    (v) => v.cadence != null || v.day != null,
    'either `cadence` or top-level `day` must be provided',
  );

export const LedgerEntryInput = z
  .object({
    id: z.string().min(1).max(64).optional(),
    description: z.string().min(1).max(200),
    amount: z.number().finite(),
    channel,
    date: isoDate,
    status: z.enum(['pending', 'cleared']).default('pending'),
    recurringId: z.string().min(1).optional(),
    occurrenceKey: z.string().min(1).optional(),
  })
  .refine(
    (e) => (e.recurringId == null) === (e.occurrenceKey == null),
    'recurringId and occurrenceKey must be both set or both null',
  );

export const SettingsInput = z.object({
  threshold: z.number().nonnegative().finite(),
  timezone: z.string().min(1).max(64),
  horizonMonths: z.number().int().min(1).max(24),
  currency: z.literal('ILS'),
  workbookUrl: z.string().trim().max(2048).optional().or(z.literal('')),
});

export type AccountInputT = z.infer<typeof AccountInput>;
export type CreditCardInputT = z.infer<typeof CreditCardInput>;
export type RecurringInputT = z.infer<typeof RecurringInput>;
export type LedgerEntryInputT = z.infer<typeof LedgerEntryInput>;
export type SettingsInputT = z.infer<typeof SettingsInput>;
