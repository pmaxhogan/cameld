-- Key/value settings store. Migrations are append-only: never edit this file
-- once it has shipped; add a new numbered migration instead.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
