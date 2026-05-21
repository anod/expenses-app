-- Add monthly prediction cadence support to recurring_template.
--
-- A monthly prediction is one synthetic occurrence per month with no exact
-- day-of-month stored in the template. It still projects on a deterministic
-- internal date in the shared pipeline, but the DB shape only needs a new
-- cadence discriminator.
--
-- IMPORTANT: the migration runner wraps migrations in a transaction, so
-- `PRAGMA foreign_keys = OFF` is not effective here. Back up and restore
-- child rows explicitly so rebuilding `recurring_template` does not wipe
-- recurring skips or persisted recurring overrides.

PRAGMA foreign_keys = OFF;

CREATE TEMP TABLE _recurring_skip_backup AS
SELECT recurring_id, occurrence_date
FROM recurring_skip;

CREATE TEMP TABLE _recurring_ledger_backup AS
SELECT id, description, amount, channel, date, status, recurring_id, occurrence_key
FROM ledger_entry
WHERE recurring_id IS NOT NULL;

CREATE TABLE recurring_template_new (
  id               TEXT PRIMARY KEY,
  description      TEXT NOT NULL,
  amount           REAL NOT NULL,
  channel          TEXT NOT NULL,
  cadence          TEXT NOT NULL DEFAULT 'monthly'
                     CHECK (cadence IN ('monthly', 'weekly', 'monthly_prediction')),
  day              INTEGER CHECK (day IS NULL OR day BETWEEN 1 AND 31),
  day_of_week      INTEGER CHECK (day_of_week IS NULL OR day_of_week BETWEEN 0 AND 6),
  start_date       TEXT NOT NULL,
  end_date         TEXT,
  month_end_policy TEXT NOT NULL DEFAULT 'clamp',
  CHECK (
    (cadence = 'monthly' AND day IS NOT NULL AND day_of_week IS NULL)
    OR
    (cadence = 'weekly' AND day IS NULL AND day_of_week IS NOT NULL)
    OR
    (cadence = 'monthly_prediction' AND day IS NULL AND day_of_week IS NULL)
  )
);

INSERT INTO recurring_template_new
  (id, description, amount, channel, cadence, day, day_of_week,
   start_date, end_date, month_end_policy)
SELECT
  id, description, amount, channel, cadence, day, day_of_week,
  start_date, end_date, month_end_policy
FROM recurring_template;

DROP TABLE recurring_template;
ALTER TABLE recurring_template_new RENAME TO recurring_template;

INSERT OR IGNORE INTO recurring_skip(recurring_id, occurrence_date)
SELECT recurring_id, occurrence_date
FROM _recurring_skip_backup;

INSERT OR REPLACE INTO ledger_entry(
  id, description, amount, channel, date, status, recurring_id, occurrence_key
)
SELECT
  id, description, amount, channel, date, status, recurring_id, occurrence_key
FROM _recurring_ledger_backup;

DROP TABLE _recurring_skip_backup;
DROP TABLE _recurring_ledger_backup;

PRAGMA foreign_keys = ON;
