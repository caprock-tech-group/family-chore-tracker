CREATE TABLE chore_wifi_status (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  checked_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  deny_enabled boolean,
  healthy boolean NOT NULL
);
