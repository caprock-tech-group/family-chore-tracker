CREATE TABLE chore_submissions (
  id uuid PRIMARY KEY,
  group_id text NOT NULL CHECK (group_id IN ('daily', 'weekly', 'extra')),
  chore_id text NOT NULL,
  period text NOT NULL,
  photo bytea NOT NULL,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'rejected')),
  note text NOT NULL DEFAULT '',
  earned integer NOT NULL DEFAULT 0 CHECK (earned >= 0),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  UNIQUE (group_id, chore_id, period)
);

CREATE INDEX chore_submissions_board ON chore_submissions (group_id, period, status);
CREATE UNIQUE INDEX chore_submissions_one_pending_extra
  ON chore_submissions (chore_id) WHERE group_id = 'extra' AND status = 'submitted';

CREATE TABLE chore_pin_attempts (
  bucket text PRIMARY KEY,
  attempts integer NOT NULL,
  starts_at timestamptz NOT NULL
);
