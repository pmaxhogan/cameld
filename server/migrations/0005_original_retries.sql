-- Original-file export outcomes (docs/ARCHITECTURE.md section 7).
-- Append-only: never edit once shipped.
--
-- original_status gains 'unavailable' (terminal: Strava has no original file,
-- e.g. a manual entry with no upload). It replaces the old 'none', so every
-- such row is renamed here. A transient export failure keeps 'pending' and
-- backs off: original_next_attempt_at is when the next try is allowed.

ALTER TABLE activities ADD COLUMN original_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE activities ADD COLUMN original_next_attempt_at INTEGER;
-- JSON: why the original is unavailable, or the last transient failure.
ALTER TABLE activities ADD COLUMN original_evidence TEXT;

UPDATE activities SET original_status = 'unavailable' WHERE original_status = 'none';
