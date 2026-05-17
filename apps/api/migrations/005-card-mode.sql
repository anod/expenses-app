-- Add a `mode` column distinguishing credit cards (default — charges
-- accumulate into a monthly bill on `billing_day_of_month`) from debit
-- cards (each charge hits the bank on its own date, no aggregation,
-- current_debit and billing_day_of_month are ignored).

ALTER TABLE credit_card
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'credit'
  CHECK (mode IN ('credit', 'debit'));
