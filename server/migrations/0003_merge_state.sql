-- Merge state machine, backups, freeze, backfill (docs/ARCHITECTURE.md
-- sections 5 to 7). Append-only: never edit once shipped.

-- Every Strava activity cameld has seen. Times are epoch milliseconds.
CREATE TABLE activities (
  id               INTEGER PRIMARY KEY,
  name             TEXT,
  sport_type       TEXT,
  start_ms         INTEGER NOT NULL,
  end_ms           INTEGER NOT NULL,
  device_name      TEXT,
  external_id      TEXT,
  source           TEXT NOT NULL,
  -- 1 for a merged activity cameld uploaded (never paired again).
  is_merge_output  INTEGER NOT NULL DEFAULT 0,
  first_seen_at    INTEGER NOT NULL,
  backed_up_at     INTEGER,
  -- pending | present | none (Strava has no original, e.g. a manual entry)
  original_status  TEXT NOT NULL DEFAULT 'pending',
  original_path    TEXT,
  original_format  TEXT,
  web_form_saved   INTEGER NOT NULL DEFAULT 0,
  single_at        INTEGER,
  gone_at          INTEGER,
  -- A deleted original re-uploaded from backup: old.restored_as = new id,
  -- new.restored_from = old id. Restored copies are never paired again.
  restored_as      INTEGER,
  restored_from    INTEGER
) STRICT;
CREATE INDEX activities_start ON activities (start_ms);

-- Every backup file written (write-once, checksummed; see backup-store.ts).
CREATE TABLE backup_files (
  activity_id INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  rel_path    TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  size        INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (activity_id, rel_path)
) STRICT;

-- One candidate group (a pair, or 1-to-N when a device split the outing).
CREATE TABLE merge_groups (
  id                 TEXT PRIMARY KEY,
  status             TEXT NOT NULL,
  path               TEXT,
  app_ids            TEXT NOT NULL,
  fitbit_ids         TEXT NOT NULL,
  start_ms           INTEGER NOT NULL,
  match_json         TEXT,
  offset_seconds     INTEGER NOT NULL DEFAULT 0,
  merged_path        TEXT,
  merged_sha256      TEXT,
  external_id        TEXT NOT NULL UNIQUE,
  upload_id          INTEGER,
  merged_activity_id INTEGER,
  snapshot           TEXT,
  parked_reason      TEXT,
  resume_status      TEXT,
  hidden_at          INTEGER,
  trial              INTEGER NOT NULL DEFAULT 0,
  photos_flagged     INTEGER NOT NULL DEFAULT 0,
  deleted_ids        TEXT NOT NULL DEFAULT '[]',
  last_error         TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
) STRICT;
CREATE INDEX merge_groups_status ON merge_groups (status);

-- Append-only transition log with evidence.
CREATE TABLE group_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id    TEXT NOT NULL,
  at          INTEGER NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  event       TEXT NOT NULL,
  evidence    TEXT NOT NULL
) STRICT;
CREATE INDEX group_events_group ON group_events (group_id, id);

-- Intent journal: written BEFORE every Strava write, completed after.
CREATE TABLE strava_writes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id     TEXT,
  kind         TEXT NOT NULL,
  target_id    INTEGER,
  external_id  TEXT,
  -- intent | done | failed | unknown | superseded
  status       TEXT NOT NULL,
  upload_id    INTEGER,
  result       TEXT,
  created_at   INTEGER NOT NULL,
  completed_at INTEGER
) STRICT;
CREATE INDEX strava_writes_open ON strava_writes (status);

-- Global write freeze (single row) and its history.
CREATE TABLE freeze (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  frozen    INTEGER NOT NULL,
  reason    TEXT,
  evidence  TEXT,
  frozen_at INTEGER
) STRICT;
CREATE TABLE freeze_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       INTEGER NOT NULL,
  action   TEXT NOT NULL,
  reason   TEXT NOT NULL,
  evidence TEXT NOT NULL
) STRICT;

-- Backfill cursor and progress (single row).
CREATE TABLE backfill_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  cursor_before INTEGER,
  done          INTEGER NOT NULL DEFAULT 0,
  activities    INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
) STRICT;

-- Backfill's own read budget, per UTC day and per 15-minute window.
CREATE TABLE backfill_budget (
  window_key TEXT PRIMARY KEY,
  reads      INTEGER NOT NULL
) STRICT;

-- Dry-run report: every group the backfill would merge, with metrics.
CREATE TABLE dry_run_report (
  group_key  TEXT PRIMARY KEY,
  start_ms   INTEGER NOT NULL,
  decision   TEXT NOT NULL,
  report     TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
