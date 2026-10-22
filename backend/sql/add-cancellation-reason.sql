ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
