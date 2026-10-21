ALTER TABLE training_slots ADD COLUMN IF NOT EXISTS training_type TEXT NOT NULL DEFAULT 'групові';
