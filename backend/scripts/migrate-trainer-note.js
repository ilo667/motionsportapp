require('dotenv').config();
const { Pool } = require('@neondatabase/serverless');

async function migrate() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not defined');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query('ALTER TABLE members ADD COLUMN IF NOT EXISTS trainer_note TEXT');
    console.log('✓ members.trainer_note');
  } finally {
    await pool.end();
  }
}

migrate().catch(e => { console.error(e.message); process.exit(1); });
