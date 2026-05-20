-- Add weekly cadence support to recurring_template.
--
-- Existing schema had day NOT NULL (BETWEEN 1 AND 31) and an implicit
-- monthly cadence. Weekly templates require day to be nullable and a new
-- day_of_week column. SQLite cannot ALTER existing CHECK constraints or
-- drop NOT NULL, so we rebuild the table.
--
-- We also introduce `recurring_skip` to store per-occurrence cancellation
-- markers (e.g. a weekly therapy session the user cancelled). Skips are
-- keyed by (recurring_id, occurrence_date) so they survive Excel re-imports
-- (the importer never touches this table; see PR #3 for the preservation
-- contract).

PRAGMA foreign_keys = OFF;

CREATE TABLE recurring_template_new (
  id               TEXT PRIMARY KEY,
  description      TEXT NOT NULL,
  amount           REAL NOT NULL,
  channel          TEXT NOT NULL,
  cadence          TEXT NOT NULL DEFAULT 'monthly'
                     CHECK (cadence IN ('monthly', 'weekly')),
  day              INTEGER CHECK (day IS NULL OR day BETWEEN 1 AND 31),
  day_of_week      INTEGER CHECK (day_of_week IS NULL OR day_of_week BETWEEN 0 AND 6),
  start_date       TEXT NOT NULL,
  end_date         TEXT,
  month_end_policy TEXT NOT NULL DEFAULT 'clamp',
  CHECK (
    (cadence = 'monthly' AND day IS NOT NULL AND day_of_week IS NULL)
    OR
    (cadence = 'weekly' AND day IS NULL AND day_of_week IS NOT NULL)
  )
);

INSERT INTO recurring_template_new
  (id, description, amount, channel, cadence, day, day_of_week,
   start_date, end_date, month_end_policy)
SELECT
  id, description, amount, channel, 'monthly', day, NULL,
  start_date, end_date, month_end_policy
FROM recurring_template;

-- ledger_entry.recurring_id references recurring_template(id); SQLite
-- silently re-resolves the FK to the renamed table because the parent
-- name stays the same after RENAME.
DROP TABLE recurring_template;
ALTER TABLE recurring_template_new RENAME TO recurring_template;

CREATE TABLE recurring_skip (
  recurring_id    TEXT NOT NULL
                    REFERENCES recurring_template(id) ON DELETE CASCADE,
  occurrence_date TEXT NOT NULL,
  PRIMARY KEY (recurring_id, occurrence_date)
);

CREATE INDEX IF NOT EXISTS ix_recurring_skip_recurring_id
  ON recurring_skip(recurring_id);

PRAGMA foreign_keys = ON;
