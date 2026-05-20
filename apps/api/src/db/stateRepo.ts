import type { Database as Db } from 'better-sqlite3';
import type {
  Account,
  CreditCard,
  LedgerEntry,
  RecurringTemplate,
  Settings,
} from '@expenses/shared';

const DEFAULT_SETTINGS: Settings = {
  threshold: 2000,
  timezone: 'Asia/Jerusalem',
  horizonMonths: 6,
  currency: 'ILS',
};

const todayIsoUtc = (): string => new Date().toISOString().slice(0, 10);

export class StateRepo {
  constructor(private readonly db: Db) {}

  getAccount(): Account {
    const row = this.db
      .prepare<[], { bank_balance: number; as_of: string }>(
        'SELECT bank_balance, as_of FROM account WHERE id = 1',
      )
      .get();
    if (!row) return { bankBalance: 0, asOf: todayIsoUtc() };
    return { bankBalance: row.bank_balance, asOf: row.as_of };
  }

  upsertAccount(a: Account): void {
    this.db
      .prepare(
        'INSERT INTO account(id, bank_balance, as_of) VALUES (1, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET bank_balance=excluded.bank_balance, as_of=excluded.as_of',
      )
      .run(a.bankBalance, a.asOf);
  }

  listCards(): CreditCard[] {
    return this.db
      .prepare<[], {
        id: string;
        name: string;
        current_debit: number;
        as_of: string;
        billing_day_of_month: number;
        excel_owned: number;
        mode: string;
      }>(
        'SELECT id, name, current_debit, as_of, billing_day_of_month, excel_owned, mode ' +
        'FROM credit_card',
      )
      .all()
      .map((r) => ({
        id: r.id,
        name: r.name,
        currentDebit: r.current_debit,
        asOf: r.as_of,
        billingDayOfMonth: r.billing_day_of_month,
        excelOwned: r.excel_owned === 1,
        mode: r.mode === 'debit' ? 'debit' : 'credit',
      }));
  }

  upsertCard(c: CreditCard): void {
    this.db
      .prepare(
        'INSERT INTO credit_card(id, name, current_debit, as_of, billing_day_of_month, excel_owned, mode) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET ' +
        'name=excluded.name, current_debit=excluded.current_debit, ' +
        'as_of=excluded.as_of, billing_day_of_month=excluded.billing_day_of_month, ' +
        'excel_owned=excluded.excel_owned, mode=excluded.mode',
      )
      .run(
        c.id,
        c.name,
        c.currentDebit,
        c.asOf,
        c.billingDayOfMonth,
        c.excelOwned ? 1 : 0,
        c.mode ?? 'credit',
      );
  }

  deleteCard(id: string): void {
    this.db.prepare('DELETE FROM credit_card WHERE id = ?').run(id);
  }

  listLedger(): LedgerEntry[] {
    return this.db
      .prepare<[], {
        id: string;
        description: string;
        amount: number;
        channel: string;
        date: string;
        status: string;
        recurring_id: string | null;
        occurrence_key: string | null;
      }>(
        'SELECT id, description, amount, channel, date, status, recurring_id, occurrence_key ' +
        'FROM ledger_entry',
      )
      .all()
      .map((r) => {
        const e: LedgerEntry = {
          id: r.id,
          description: r.description,
          amount: r.amount,
          channel: r.channel as LedgerEntry['channel'],
          date: r.date,
          status: r.status as LedgerEntry['status'],
        };
        if (r.recurring_id != null) e.recurringId = r.recurring_id;
        if (r.occurrence_key != null) e.occurrenceKey = r.occurrence_key;
        return e;
      });
  }

  upsertLedger(e: LedgerEntry): void {
    this.db
      .prepare(
        'INSERT INTO ledger_entry(id, description, amount, channel, date, status, recurring_id, occurrence_key) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET description=excluded.description, amount=excluded.amount, ' +
        'channel=excluded.channel, date=excluded.date, status=excluded.status, ' +
        'recurring_id=excluded.recurring_id, occurrence_key=excluded.occurrence_key',
      )
      .run(
        e.id,
        e.description,
        e.amount,
        e.channel,
        e.date,
        e.status,
        e.recurringId ?? null,
        e.occurrenceKey ?? null,
      );
  }

  deleteLedger(id: string): void {
    this.db.prepare('DELETE FROM ledger_entry WHERE id = ?').run(id);
  }

  listRecurring(): RecurringTemplate[] {
    const skipsByTpl = new Map<string, string[]>();
    for (const s of this.db
      .prepare<[], { recurring_id: string; occurrence_date: string }>(
        'SELECT recurring_id, occurrence_date FROM recurring_skip ORDER BY occurrence_date',
      )
      .all()) {
      let arr = skipsByTpl.get(s.recurring_id);
      if (!arr) {
        arr = [];
        skipsByTpl.set(s.recurring_id, arr);
      }
      arr.push(s.occurrence_date);
    }

    return this.db
      .prepare<[], {
        id: string;
        description: string;
        amount: number;
        channel: string;
        cadence: string;
        day: number | null;
        day_of_week: number | null;
        start_date: string;
        end_date: string | null;
        month_end_policy: string;
      }>(
        'SELECT id, description, amount, channel, cadence, day, day_of_week, ' +
        'start_date, end_date, month_end_policy ' +
        'FROM recurring_template',
      )
      .all()
      .map((r) => {
        const cadence: RecurringTemplate['cadence'] =
          r.cadence === 'weekly'
            ? { kind: 'weekly', dayOfWeek: r.day_of_week as 0 | 1 | 2 | 3 | 4 | 5 | 6 }
            : {
                kind: 'monthly',
                day: r.day as number,
                monthEndPolicy: r.month_end_policy as 'clamp',
              };
        const t: RecurringTemplate = {
          id: r.id,
          description: r.description,
          amount: r.amount,
          channel: r.channel as RecurringTemplate['channel'],
          cadence,
          startDate: r.start_date,
        };
        if (r.end_date != null) t.endDate = r.end_date;
        const skips = skipsByTpl.get(r.id);
        if (skips && skips.length > 0) t.skips = skips;
        return t;
      });
  }

  upsertRecurring(t: RecurringTemplate): void {
    const cadenceKind = t.cadence.kind;
    const day = t.cadence.kind === 'monthly' ? t.cadence.day : null;
    const dayOfWeek = t.cadence.kind === 'weekly' ? t.cadence.dayOfWeek : null;
    const monthEndPolicy =
      t.cadence.kind === 'monthly' ? t.cadence.monthEndPolicy : 'clamp';
    this.db
      .prepare(
        'INSERT INTO recurring_template(id, description, amount, channel, cadence, day, day_of_week, start_date, end_date, month_end_policy) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET description=excluded.description, amount=excluded.amount, ' +
        'channel=excluded.channel, cadence=excluded.cadence, day=excluded.day, ' +
        'day_of_week=excluded.day_of_week, start_date=excluded.start_date, ' +
        'end_date=excluded.end_date, month_end_policy=excluded.month_end_policy',
      )
      .run(
        t.id,
        t.description,
        t.amount,
        t.channel,
        cadenceKind,
        day,
        dayOfWeek,
        t.startDate,
        t.endDate ?? null,
        monthEndPolicy,
      );
    // Note: skips are intentionally NOT touched here. They are managed
    // via addSkip/removeSkip so importer re-upserts preserve them.
  }

  deleteRecurring(id: string): void {
    // ON DELETE CASCADE on recurring_skip cleans up any skip rows.
    this.db.prepare('DELETE FROM recurring_template WHERE id = ?').run(id);
  }

  /**
   * Mark an occurrence of `recurringId` on `date` as skipped. Idempotent.
   * Returns true if a new skip was inserted, false if it already existed.
   */
  addSkip(recurringId: string, date: string): boolean {
    const info = this.db
      .prepare(
        'INSERT OR IGNORE INTO recurring_skip(recurring_id, occurrence_date) VALUES (?, ?)',
      )
      .run(recurringId, date);
    return info.changes > 0;
  }

  /**
   * Remove a skip marker. Idempotent. Returns true if a row was removed.
   */
  removeSkip(recurringId: string, date: string): boolean {
    const info = this.db
      .prepare('DELETE FROM recurring_skip WHERE recurring_id = ? AND occurrence_date = ?')
      .run(recurringId, date);
    return info.changes > 0;
  }

  /**
   * Resolve the persisted ledger override (if any) for the given
   * recurring template occurrence. Used by skip routes to decide
   * whether to delete a pending override or refuse on a cleared one.
   */
  findRecurringOverride(
    recurringId: string,
    date: string,
  ): { id: string; status: 'pending' | 'cleared' } | null {
    const row = this.db
      .prepare<[string, string], { id: string; status: string }>(
        'SELECT id, status FROM ledger_entry WHERE recurring_id = ? AND occurrence_key = ?',
      )
      .get(recurringId, `${recurringId}@${date}`);
    return row ? { id: row.id, status: row.status as 'pending' | 'cleared' } : null;
  }

  getSettings(): Settings {
    const row = this.db
      .prepare<[], {
        threshold: number;
        timezone: string;
        horizon_months: number;
        currency: string;
        workbook_url: string | null;
      }>('SELECT threshold, timezone, horizon_months, currency, workbook_url FROM settings WHERE id = 1')
      .get();
    if (!row) return DEFAULT_SETTINGS;
    const s: Settings = {
      threshold: row.threshold,
      timezone: row.timezone,
      horizonMonths: row.horizon_months,
      currency: row.currency as 'ILS',
    };
    if (row.workbook_url != null && row.workbook_url !== '') {
      s.workbookUrl = row.workbook_url;
    }
    return s;
  }

  upsertSettings(s: Settings): void {
    this.db
      .prepare(
        'INSERT INTO settings(id, threshold, timezone, horizon_months, currency, workbook_url) ' +
        'VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ' +
        'threshold=excluded.threshold, timezone=excluded.timezone, ' +
        'horizon_months=excluded.horizon_months, currency=excluded.currency, ' +
        'workbook_url=excluded.workbook_url',
      )
      .run(
        s.threshold,
        s.timezone,
        s.horizonMonths,
        s.currency,
        s.workbookUrl && s.workbookUrl.trim() !== '' ? s.workbookUrl.trim() : null,
      );
  }
}
