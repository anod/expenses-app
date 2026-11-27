ALTER TABLE settings ADD COLUMN budget_monthly REAL CHECK (budget_monthly >= 0);
ALTER TABLE settings ADD COLUMN budget_remaining REAL CHECK (budget_remaining >= 0);
ALTER TABLE settings ADD COLUMN budget_as_of TEXT CHECK (
  (budget_as_of IS NULL AND budget_monthly IS NULL AND budget_remaining IS NULL)
  OR (budget_as_of IS NOT NULL AND budget_monthly IS NOT NULL AND budget_remaining IS NOT NULL)
);
