PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS account (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  bank_balance  REAL    NOT NULL DEFAULT 0,
  as_of         TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS credit_card (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  current_debit        REAL NOT NULL DEFAULT 0 CHECK (current_debit >= 0),
  as_of                TEXT NOT NULL,
  billing_day_of_month INTEGER NOT NULL CHECK (billing_day_of_month BETWEEN 1 AND 31)
);

CREATE TABLE IF NOT EXISTS recurring_template (
  id               TEXT PRIMARY KEY,
  description      TEXT NOT NULL,
  amount           REAL NOT NULL,
  channel          TEXT NOT NULL,
  day              INTEGER NOT NULL CHECK (day BETWEEN 1 AND 31),
  start_date       TEXT NOT NULL,
  end_date         TEXT,
  month_end_policy TEXT NOT NULL DEFAULT 'clamp'
);

CREATE TABLE IF NOT EXISTS ledger_entry (
  id              TEXT PRIMARY KEY,
  description     TEXT NOT NULL,
  amount          REAL NOT NULL,
  channel         TEXT NOT NULL,
  date            TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','cleared')),
  recurring_id    TEXT REFERENCES recurring_template(id) ON DELETE SET NULL,
  occurrence_key  TEXT,
  CHECK ((recurring_id IS NULL) = (occurrence_key IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ledger_occurrence_key
  ON ledger_entry(occurrence_key) WHERE occurrence_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_ledger_date ON ledger_entry(date);
CREATE INDEX IF NOT EXISTS ix_ledger_channel ON ledger_entry(channel);

CREATE TABLE IF NOT EXISTS settings (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  threshold       REAL    NOT NULL DEFAULT 2000,
  timezone        TEXT    NOT NULL DEFAULT 'Asia/Jerusalem',
  horizon_months  INTEGER NOT NULL DEFAULT 6 CHECK (horizon_months BETWEEN 1 AND 24),
  currency        TEXT    NOT NULL DEFAULT 'ILS'
);
