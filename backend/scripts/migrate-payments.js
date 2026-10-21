require('dotenv').config();
const { Pool } = require('@neondatabase/serverless');

async function migrate() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not defined');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_status TEXT");
    console.log('✓ bookings.payment_status');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        booking_id UUID NOT NULL REFERENCES bookings(id),
        order_id TEXT NOT NULL UNIQUE,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'UAH',
        status TEXT NOT NULL DEFAULT 'PENDING',
        liqpay_payment_id TEXT,
        raw_callback JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log('✓ payments table');
  } finally {
    await pool.end();
  }
}

migrate().catch(e => { console.error(e.message); process.exit(1); });
