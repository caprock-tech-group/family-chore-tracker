CREATE TABLE chore_wifi_bedtimes (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  schedule jsonb NOT NULL
);
