ALTER TABLE chore_submissions
  ADD COLUMN extra_photos bytea[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT proof_photo_limit CHECK (cardinality(extra_photos) <= 5);
