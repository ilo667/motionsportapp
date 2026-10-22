require('dotenv').config();
const { Pool } = require('@neondatabase/serverless');

async function migrate() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not defined');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query('ALTER TABLE members ADD COLUMN IF NOT EXISTS coach_id UUID REFERENCES admins(id)');
    console.log('✓ members.coach_id');
    // While there is a single coach, existing clients are theirs (otherwise all would land in «Без тренера»)
    const { rows } = await pool.query('SELECT id FROM admins');
    if (rows.length === 1) {
      const res = await pool.query('UPDATE members SET coach_id = $1 WHERE coach_id IS NULL', [rows[0].id]);
      console.log(`✓ ${res.rowCount} existing members assigned to the only coach`);
    } else {
      console.log(`• ${rows.length} coaches — existing members left unassigned`);
    }
  } finally {
    await pool.end();
  }
}

migrate().catch(e => { console.error(e.message); process.exit(1); });
