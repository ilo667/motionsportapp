require('dotenv').config();
const { Pool } = require('@neondatabase/serverless');

// Phone-side time of the cancel/move confirmation: never read, and cancelled_at (server time) covers it.
// Run AFTER the backend that no longer writes it is deployed, or cancellations fail in between
async function migrate() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not defined');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query('ALTER TABLE bookings DROP COLUMN IF EXISTS cancellation_reason_at');
    console.log('✓ bookings.cancellation_reason_at dropped');
  } finally {
    await pool.end();
  }
}

migrate().catch(e => { console.error(e.message); process.exit(1); });
