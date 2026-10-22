require('dotenv').config();
const { Pool } = require('@neondatabase/serverless');

async function migrate() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not defined');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS slot_members (
        slot_id UUID NOT NULL REFERENCES training_slots(id),
        member_id UUID NOT NULL REFERENCES members(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (slot_id, member_id)
      )`);
    console.log('✓ slot_members');
    // Personal trainings: a member may have a group booking and several personal ones on the same day
    await pool.query('DROP INDEX IF EXISTS bookings_member_day_active_idx');
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS bookings_member_slot_active_idx ON bookings (member_id, slot_id) WHERE status = 'ACTIVE'`,
    );
    console.log('✓ bookings_member_slot_active_idx');
    // Fixed capacity for personal slots (older ones were created with 8)
    const fixed = await pool.query(
      `UPDATE training_slots SET capacity = CASE training_type WHEN 'індивідуальні' THEN 1 ELSE 3 END
       WHERE training_type IN ('індивідуальні', 'спліт')
         AND capacity <> CASE training_type WHEN 'індивідуальні' THEN 1 ELSE 3 END`,
    );
    console.log(`✓ personal slot capacity (${fixed.rowCount} fixed)`);
  } finally {
    await pool.end();
  }
}

migrate().catch(e => { console.error(e.message); process.exit(1); });
