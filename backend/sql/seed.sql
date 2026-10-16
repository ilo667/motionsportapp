DO $$
DECLARE
  v_id BIGINT;
BEGIN
  -- Find an existing version that already has our questions
  SELECT qv.id INTO v_id
  FROM quiz_versions qv
  JOIN questions q ON q.quiz_version_id = qv.id
  WHERE q.question_key = 'consistent_training'
  LIMIT 1;

  -- Deactivate all versions
  UPDATE quiz_versions SET is_active = FALSE;

  IF v_id IS NULL THEN
    INSERT INTO quiz_versions (is_active) VALUES (TRUE) RETURNING id INTO v_id;
  ELSE
    UPDATE quiz_versions SET is_active = TRUE WHERE id = v_id;
  END IF;
END $$;

INSERT INTO questions (quiz_version_id, question_key, question_text, position)
SELECT qv.id, q.question_key, q.question_text, q.position
FROM quiz_versions qv
CROSS JOIN (VALUES
  ('consistent_training',  'I maintain a consistent training schedule each week',          1),
  ('track_personal_bests', 'I track my personal bests and review them regularly',          2),
  ('recover_well',         'I recover well after intense physical activity',               3),
  ('stay_focused',         'I stay focused and motivated during competitions',             4),
  ('set_goals',            'I set specific performance goals for each training cycle',     5)
) AS q(question_key, question_text, position)
WHERE qv.is_active = TRUE
ON CONFLICT (quiz_version_id, question_key) DO UPDATE SET
  question_text = EXCLUDED.question_text,
  position = EXCLUDED.position;