ALTER TABLE chore_wifi_override
  ADD COLUMN grounding_days integer CHECK (grounding_days BETWEEN 1 AND 365),
  ADD COLUMN started_on text,
  ADD COLUMN started_at timestamptz,
  ADD CONSTRAINT grounding_dates_required CHECK (
    grounding_days IS NULL OR (started_on IS NOT NULL AND started_at IS NOT NULL)
  );

CREATE FUNCTION chore_wifi_grounding(today text)
RETURNS TABLE(blocked boolean, days integer, remaining integer)
LANGUAGE sql STABLE AS $$
  SELECT
    o.grounding_days IS NULL OR progress.completed < o.grounding_days OR
      (progress.completed = o.grounding_days AND progress.latest = today),
    o.grounding_days,
    CASE WHEN o.grounding_days IS NOT NULL
      THEN greatest(o.grounding_days - progress.completed, 0)::integer END
  FROM chore_wifi_override o
  CROSS JOIN LATERAL (
    SELECT count(*) AS completed, max(period) AS latest
    FROM (
      SELECT period
      FROM chore_submissions
      WHERE o.grounding_days IS NOT NULL AND group_id = 'daily'
        AND period BETWEEN o.started_on AND today AND status = 'approved'
        AND chore_id IN ('room', 'kitchen', 'gear', 'dog')
      GROUP BY period
      HAVING count(*) = 4 AND max(reviewed_at) >= o.started_at
      ORDER BY period
      LIMIT o.grounding_days
    ) qualifying
  ) progress
$$;
