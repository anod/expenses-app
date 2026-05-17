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

export const RecurringInput = z.object({
  id: z.string().min(1).max(64).optional(),
  description: z.string().min(1).max(200),
  amount: z.number().finite(),
  channel,
  day: z.number().int().min(1).max(31),
  startDate: isoDate,
  endDate: isoDate.optional(),
  monthEndPolicy: z.literal('clamp').default('clamp'),
});

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
