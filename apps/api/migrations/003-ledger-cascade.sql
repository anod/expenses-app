-- Fix: ledger_entry.recurring_id used ON DELETE SET NULL together with
-- CHECK ((recurring_id IS NULL) = (occurrence_key IS NULL)). Deleting a
-- recurring template with cleared overrides would null only recurring_id,
-- violating the CHECK and aborting the delete.
--
-- Switch to ON DELETE CASCADE: deleting a template removes its overrides
-- with it. User-visible consequence: clearing an occurrence of a template
-- you later delete loses the cleared override. Acceptable trade-off — the
-- template is gone, so the occurrences won't reappear in the forecast
-- regardless. Documented in plan.md.

PRAGMA foreign_keys = OFF;

CREATE TABLE ledger_entry_new (
  id              TEXT PRIMARY KEY,
  description     TEXT NOT NULL,
  amount          REAL NOT NULL,
  channel         TEXT NOT NULL,
  date            TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','cleared')),
  recurring_id    TEXT REFERENCES recurring_template(id) ON DELETE CASCADE,
  occurrence_key  TEXT,
  CHECK ((recurring_id IS NULL) = (occurrence_key IS NULL))
);

INSERT INTO ledger_entry_new
  (id, description, amount, channel, date, status, recurring_id, occurrence_key)
SELECT id, description, amount, channel, date, status, recurring_id, occurrence_key
  FROM ledger_entry;

DROP TABLE ledger_entry;
ALTER TABLE ledger_entry_new RENAME TO ledger_entry;

CREATE UNIQUE INDEX IF NOT EXISTS ux_ledger_occurrence_key
  ON ledger_entry(occurrence_key) WHERE occurrence_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_ledger_date ON ledger_entry(date);
CREATE INDEX IF NOT EXISTS ix_ledger_channel ON ledger_entry(channel);

PRAGMA foreign_keys = ON;
