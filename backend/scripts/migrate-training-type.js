require('dotenv').config();
const { Pool } = require('@neondatabase/serverless');

async function migrate() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not defined');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query("ALTER TABLE training_days ADD COLUMN IF NOT EXISTS training_type TEXT NOT NULL DEFAULT 'групові'");
    console.log('✓ training_days.training_type');

    await pool.query("ALTER TABLE training_slots ADD COLUMN IF NOT EXISTS training_type TEXT NOT NULL DEFAULT 'групові'");
    console.log('✓ training_slots.training_type');
  } finally {
    await pool.end();
  }
}

migrate().catch(e => { console.error(e.message); process.exit(1); });