require('dotenv').config();
const { Pool } = require('@neondatabase/serverless');

// Demo mode is gone: drop its clock/scenario table. Test data only, so a single step
async function migrate() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not defined');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query('DROP TABLE IF EXISTS demo_state');
    console.log('✓ demo_state dropped');
  } finally {
    await pool.end();
  }
}

migrate().catch(e => { console.error(e.message); process.exit(1); });
