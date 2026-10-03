-- Web UI: audit log of every owner write and Web Push subscriptions
-- (docs/ARCHITECTURE.md section 8). Append-only: never edit once shipped.

-- Every write route of the UI, with who, what, and how it ended.
CREATE TABLE audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  target  TEXT,
  -- ok | refused | failed
  outcome TEXT NOT NULL,
  details TEXT NOT NULL
) STRICT;
CREATE INDEX audit_log_at ON audit_log (at);

-- One row per browser push subscription. The endpoint is a capability URL:
-- it is stored here and nowhere else (logs and the audit log use its hash).
CREATE TABLE push_subscriptions (
  endpoint_hash TEXT PRIMARY KEY,
  endpoint      TEXT NOT NULL,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  user_agent    TEXT,
  created_at    INTEGER NOT NULL,
  last_ok_at    INTEGER,
  last_error    TEXT,
  failures      INTEGER NOT NULL DEFAULT 0
) STRICT;
