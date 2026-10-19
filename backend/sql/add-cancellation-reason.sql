ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
  ADD COLUMN IF NOT EXISTS cancellation_reason_at TIMESTAMPTZ;