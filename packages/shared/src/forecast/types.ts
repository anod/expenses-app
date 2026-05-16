/** ISO date string, YYYY-MM-DD, in the configured timezone. */
export type IsoDate = string;

/** Sign convention: negative = outflow, positive = inflow. */
export type Amount = number;

export type EntryStatus = 'pending' | 'cleared';

/**
 * Channel that this ledger entry affects.
 * - 'bank'        directly hits the bank balance on its date
 * - 'cc:<cardId>' adds to a credit card's balance and hits the bank on the
 *                 first billing day strictly after the entry date.
 */
export type Channel = 'bank' | `cc:${string}`;

export interface Account {
  bankBalance: number;
  /** Snapshot date for `bankBalance`. Must not be in the future. */
  asOf: IsoDate;
}

export interface CreditCard {
  id: string;
  name: string;
  /** Outstanding liability at end-of-day `asOf`. Stored as non-negative. */
  currentDebit: number;
  /** Snapshot date for `currentDebit`. Must not be in the future. */
  asOf: IsoDate;
  /** Day of month the bill is debited from the bank. 1..31. */
  billingDayOfMonth: number;
}

export type MonthEndPolicy = 'clamp';

export interface RecurringTemplate {
  id: string;
  description: string;
  amount: Amount;
  channel: Channel;
  /** Day of month, 1..31. */
  day: number;
  /** Inclusive ISO date when the cadence starts. */
  startDate: IsoDate;
  /** Inclusive ISO date when the cadence ends. Omit for open-ended. */
  endDate?: IsoDate;
  monthEndPolicy: MonthEndPolicy;
}

export interface OccurrenceKey {
  recurringId: string;
  occurrenceDate: IsoDate;
}

export interface LedgerEntry {
  id: string;
  description: string;
  amount: Amount;
  channel: Channel;
  date: IsoDate;
  status: EntryStatus;
  /** Set IFF this entry was generated from a recurring template. */
  recurringId?: string;
  /** Set IFF `recurringId` is set. Format: `${recurringId}@${date}`. */
  occurrenceKey?: string;
}

export interface Settings {
  threshold: number;
  timezone: string;
  horizonMonths: number;
  currency: 'ILS';
}

export type ChargeSource =
  | { kind: 'ledger'; entryId: string }
  | { kind: 'cc-bill'; cardId: string; billedEntries: LedgerEntry[] };

export interface ProjectionCharge {
  description: string;
  amount: Amount;
  source: ChargeSource;
}

export interface DailyProjection {
  date: IsoDate;
  balance: number;
  delta: number;
  charges: ProjectionCharge[];
  isAnchor: boolean;
}

export type ForecastStatus = 'safe' | 'warning' | 'breach';

export interface CardDailyBalance {
  date: IsoDate;
  /** Non-negative outstanding debit at end of `date`. */
  outstanding: number;
  /** True when `date` is this card's billing day (debt was settled then). */
  isBillingDay: boolean;
}

export interface CardForecast {
  cardId: string;
  name: string;
  billingDayOfMonth: number;
  asOf: IsoDate;
  /** Outstanding debit AT card.asOf (i.e. starting point). */
  openingDebit: number;
  /** Day-by-day outstanding over the forecast window. */
  days: CardDailyBalance[];
}

export interface ForecastResult {
  startDate: IsoDate;
  endDate: IsoDate;
  days: DailyProjection[];
  status: ForecastStatus;
  minBalance: number;
  minBalanceDate: IsoDate;
  cards: CardForecast[];
}

export const occurrenceKeyOf = (recurringId: string, date: IsoDate): string =>
  `${recurringId}@${date}`;
