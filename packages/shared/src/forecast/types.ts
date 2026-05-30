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
  /**
   * Card behaviour:
   * - 'credit' (default): charges accumulate and a single aggregated bill
   *   hits the bank on `billingDayOfMonth`.
   * - 'debit': each charge hits the bank on its own date (no aggregation,
   *   `currentDebit` is ignored, `billingDayOfMonth` is ignored).
   */
  mode?: 'credit' | 'debit';
  /**
   * True when this card was created by the Excel importer. The importer
   * may freely delete/recreate these on re-import. User-created cards
   * (POST /api/cards) have `excelOwned = false` and are preserved
   * across re-imports.
   */
  excelOwned?: boolean;
}

export type MonthEndPolicy = 'clamp';

/** Day-of-week, 0=Sunday..6=Saturday (matches `Date#getUTCDay()`). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Monthly cadence: a single occurrence per calendar month on `day`. */
export interface MonthlyCadence {
  kind: 'monthly';
  /** Day of month, 1..31 (clamped via `monthEndPolicy` when too large). */
  day: number;
  monthEndPolicy: MonthEndPolicy;
}

/** Weekly cadence: an occurrence every `dayOfWeek` (0=Sun..6=Sat). */
export interface WeeklyCadence {
  kind: 'weekly';
  dayOfWeek: Weekday;
}

/**
 * Monthly prediction: one synthetic occurrence per month, used for rows that
 * conceptually belong to a month/period but do not have an exact business day.
 * Projection still needs a stable date, so the pipeline posts these on the
 * anchor day for the month.
 */
export interface MonthlyPredictionCadence {
  kind: 'monthly_prediction';
}

export type Cadence = MonthlyCadence | WeeklyCadence | MonthlyPredictionCadence;

export interface RecurringTemplate {
  id: string;
  description: string;
  amount: Amount;
  channel: Channel;
  cadence: Cadence;
  /** Inclusive ISO date when the cadence starts. */
  startDate: IsoDate;
  /** Inclusive ISO date when the cadence ends. Omit for open-ended. */
  endDate?: IsoDate;
  /**
   * ISO dates the user has marked as skipped — neither virtual nor
   * persisted ledger rows with `occurrenceKey === occurrenceKeyOf(id,date)`
   * appear in any forecast or report. Sorted ascending, deduped.
   * Meaningful for any generated cadence whose occurrences should be omitted.
   */
  skips?: IsoDate[];
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
  /**
   * OneDrive Excel workbook share URL used for Graph reads / sync / import.
   * When empty/undefined, the server falls back to the ONEDRIVE_WORKBOOK_URL
   * env var. Stored in DB so it can be edited from the Settings UI without
   * touching .env.
   */
  workbookUrl?: string;
  /** Yahoo Finance ticker used to refresh ESOP stock price. */
  esopStockSymbol?: string;
  /** Yahoo Finance ticker used to refresh ESOP USD/NIS rate. */
  esopFxSymbol?: string;
}

export type ChargeSource =
  | {
      kind: 'ledger';
      entryId: string;
      /** Set IFF the underlying ledger entry is from a recurring template. */
      recurringId?: string;
      /** Set IFF `recurringId` is set; format `${recurringId}@${date}`. */
      occurrenceKey?: string;
    }
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
  /** Raw `currentDebit` from the card snapshot (liability at end-of-day `asOf`). */
  snapshotDebit: number;
  /** Outstanding debit projected at the first emitted day (visibleStart). */
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
  /** Snapshot of the bank account at the time of forecast (last user update). */
  account: {
    asOf: IsoDate;
    /** Bank balance as user last entered it (end-of-day at asOf). */
    bankBalance: number;
  };
}

export const occurrenceKeyOf = (recurringId: string, date: IsoDate): string =>
  `${recurringId}@${date}`;
