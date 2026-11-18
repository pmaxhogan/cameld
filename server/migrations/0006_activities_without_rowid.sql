-- activities.id stops being the table's rowid (docs/ARCHITECTURE.md section 3).
-- Append-only: never edit once shipped.
--
-- Strava ids are moving to the full 64-bit range. As INTEGER PRIMARY KEY of a
-- rowid table, activities.id WAS the rowid, so inserting an activity made its
-- id the connection's last_insert_rowid. node:sqlite reports that value from
-- every later statement.run() and (from Node 26.13) throws when it does not
-- fit a JavaScript number: one 64-bit activity id would have made every
-- following write on the connection fail.
--
-- A WITHOUT ROWID table has no rowid and never touches last_insert_rowid. The
-- id stays an INTEGER (exact signed 64-bit, numeric order) and the primary
-- key. Same columns, types, defaults and index as 0003 + 0005; every row is
-- copied as it is.

CREATE TABLE activities_without_rowid (
  id                       INTEGER PRIMARY KEY,
  name                     TEXT,
  sport_type               TEXT,
  start_ms                 INTEGER NOT NULL,
  end_ms                   INTEGER NOT NULL,
  device_name              TEXT,
  external_id              TEXT,
  source                   TEXT NOT NULL,
  -- 1 for a merged activity cameld uploaded (never paired again).
  is_merge_output          INTEGER NOT NULL DEFAULT 0,
  first_seen_at            INTEGER NOT NULL,
  backed_up_at             INTEGER,
  -- pending | present | unavailable (Strava has no original, e.g. a manual entry)
  original_status          TEXT NOT NULL DEFAULT 'pending',
  original_path            TEXT,
  original_format          TEXT,
  web_form_saved           INTEGER NOT NULL DEFAULT 0,
  single_at                INTEGER,
  gone_at                  INTEGER,
  -- A deleted original re-uploaded from backup: old.restored_as = new id,
  -- new.restored_from = old id. Restored copies are never paired again.
  restored_as              INTEGER,
  restored_from            INTEGER,
  -- Transient export failures since the last success, and the backoff.
  original_attempts        INTEGER NOT NULL DEFAULT 0,
  original_next_attempt_at INTEGER,
  -- JSON: why the original is unavailable, or the last transient failure.
  original_evidence        TEXT
) STRICT, WITHOUT ROWID;

INSERT INTO activities_without_rowid (
  id, name, sport_type, start_ms, end_ms, device_name, external_id, source,
  is_merge_output, first_seen_at, backed_up_at, original_status, original_path,
  original_format, web_form_saved, single_at, gone_at, restored_as, restored_from,
  original_attempts, original_next_attempt_at, original_evidence
)
SELECT
  id, name, sport_type, start_ms, end_ms, device_name, external_id, source,
  is_merge_output, first_seen_at, backed_up_at, original_status, original_path,
  original_format, web_form_saved, single_at, gone_at, restored_as, restored_from,
  original_attempts, original_next_attempt_at, original_evidence
FROM activities;

-- Dropping the old table drops its index with it.
DROP TABLE activities;
ALTER TABLE activities_without_rowid RENAME TO activities;
CREATE INDEX activities_start ON activities (start_ms);
