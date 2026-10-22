require('dotenv').config();
const { Pool } = require('@neondatabase/serverless');

// Two steps, because the backend that is live during the deploy still creates slots without a coach:
//   node scripts/migrate-slot-coach.js           — BEFORE deploy: add the column, give existing slots to the first coach
//   node scripts/migrate-slot-coach.js finalize  — AFTER deploy: fill anything created meanwhile, then NOT NULL
async function migrate() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not defined');
  const finalize = process.argv[2] === 'finalize';
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query('ALTER TABLE training_slots ADD COLUMN IF NOT EXISTS coach_id UUID REFERENCES admins(id)');
    const res = await pool.query(
      'UPDATE training_slots SET coach_id = (SELECT id FROM admins ORDER BY created_at LIMIT 1) WHERE coach_id IS NULL',
    );
    console.log(`✓ training_slots.coach_id (${res.rowCount} slots → first coach)`);
    if (finalize) {
      await pool.query('ALTER TABLE training_slots ALTER COLUMN coach_id SET NOT NULL');
      console.log('✓ coach_id NOT NULL');
    } else {
      console.log('• run again with "finalize" after the new backend is deployed');
    }
  } finally {
    await pool.end();
  }
}

migrate().catch(e => { console.error(e.message); process.exit(1); });
