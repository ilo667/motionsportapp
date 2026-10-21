ALTER TABLE training_days
  ADD COLUMN IF NOT EXISTS training_type TEXT NOT NULL DEFAULT 'групові';