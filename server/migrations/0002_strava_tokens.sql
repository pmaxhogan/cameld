-- Single-row OAuth token store. The refresh token rotates on every refresh, so
-- the newest one is upserted atomically (one statement) each time.
CREATE TABLE strava_tokens (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  updated_at    TEXT NOT NULL
) STRICT;
