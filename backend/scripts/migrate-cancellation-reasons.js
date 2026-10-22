require('dotenv').config();
const { Pool } = require('@neondatabase/serverless');

async function migrate() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not defined');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(
      'ALTER TABLE bookings ADD COLUMN IF NOT EXISTS switched_to_slot_id UUID REFERENCES training_slots(id)',
    );
    console.log('✓ bookings.switched_to_slot_id');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_push_subscriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        admin_id UUID NOT NULL REFERENCES admins(id),
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        disabled_at TIMESTAMPTZ
      )`);
    console.log('✓ admin_push_subscriptions');
  } finally {
    await pool.end();
  }
}

migrate().catch(e => { console.error(e.message); process.exit(1); });
