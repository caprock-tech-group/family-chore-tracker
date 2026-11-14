CREATE TABLE chore_push_subscriptions (
  endpoint text PRIMARY KEY,
  role text NOT NULL CHECK (role IN ('parent', 'son')),
  subscription jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
