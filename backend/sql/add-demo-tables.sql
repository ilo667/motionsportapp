CREATE TABLE IF NOT EXISTS demo_state (
  id INTEGER PRIMARY KEY DEFAULT 1,
  clock_override_at TIMESTAMPTZ,
  scenario_name TEXT
);

INSERT INTO demo_state (id) VALUES (1) ON CONFLICT DO NOTHING;