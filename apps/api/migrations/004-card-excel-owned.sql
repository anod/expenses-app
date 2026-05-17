-- Add an `excel_owned` flag so the Excel importer can wipe and recreate
-- ONLY the cards it owns, leaving user-created cards (POST /api/cards)
-- intact. Without this, re-importing the workbook deleted every card —
-- so any preserved user ledger/recurring row pointing at cc:<userCardId>
-- would then orphan and break the forecast.

ALTER TABLE credit_card ADD COLUMN excel_owned INTEGER NOT NULL DEFAULT 0;
