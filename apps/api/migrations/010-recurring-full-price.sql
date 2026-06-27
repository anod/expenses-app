-- Add an optional full-price column to recurring_template for installments.
--
-- For installments the per-payment `amount` is the standard rounded value and
-- `full_price` is the (signed) total split across the scheduled payments; the
-- shared forecast engine makes the final occurrence absorb the rounding
-- remainder. The column is nullable and only set for installment templates.
--
-- A single nullable column add does not touch the table's CHECK constraints or
-- child rows, so a plain ALTER TABLE is safe (no rebuild/backup needed).

ALTER TABLE recurring_template ADD COLUMN full_price REAL;
