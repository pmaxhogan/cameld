import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrate, openDatabase } from "../src/db.ts";
import { requireActivity, setActivityFields, upsertActivity } from "../src/state/repo.ts";
import { memoryDb } from "./state-helpers.ts";

/**
 * Migration 0006 rebuilds `activities` without a rowid. It runs once, at boot,
 * on the live database, so it must carry every row over exactly. SYNTHETIC
 * rows only.
 */

const BEFORE = [
  "0001_settings.sql",
  "0002_strava_tokens.sql",
  "0003_merge_state.sql",
  "0004_ui.sql",
  "0005_original_retries.sql",
];
const MIGRATION = "0006_activities_without_rowid.sql";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const shipped = (name: string): string => readFileSync(join(MIGRATIONS_DIR, name), "utf8");

/** A database as the previous version left it, with rows in every table 0006 could touch. */
function databaseBefore(): { db: DatabaseSync; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "cameld-0006-"));
  cleanup.push(root);
  const dir = join(root, "migrations");
  mkdirSync(dir);
  for (const name of BEFORE) writeFileSync(join(dir, name), shipped(name));
  const db = openDatabase(":memory:");
  migrate(db, dir);
  // exec, not run(): this is the old rowid table, where a large id is the trap 0006 removes.
  db.exec(`
    -- Every column set.
    INSERT INTO activities VALUES (9400101, 'Synthetic Loop', 'Run', 1000, 2000, 'Strava App',
      'synthetic-1.fit', 'app', 0, 10, 20, 'present', 'activities/9400101/original/a.fit', 'fit',
      1, 30, 40, 9400401, NULL, 2, 50, '{"reason":"synthetic"}');
    -- Every nullable column null, every default left to the table.
    INSERT INTO activities (id, start_ms, end_ms, source, first_seen_at)
      VALUES (9400102, 3000, 4000, 'fitbit', 11);
    -- A merge output, a restored copy, an unavailable original, text with quotes and a newline.
    INSERT INTO activities (id, name, start_ms, end_ms, source, is_merge_output, first_seen_at,
      original_status, restored_from, original_evidence)
      VALUES (9400401, 'It''s a "synthetic"' || char(10) || 'name', 1000, 2000, 'other', 1, 12,
      'unavailable', 9400101, '{"reason":"manual"}');
    -- Ids either side of 2^53, and the largest signed 64-bit integer.
    INSERT INTO activities (id, start_ms, end_ms, source, first_seen_at)
      VALUES (9007199254740992, 5000, 6000, 'app', 13);
    INSERT INTO activities (id, start_ms, end_ms, source, first_seen_at, restored_as)
      VALUES (9007199254740993, 5000, 6000, 'app', 14, 9223372036854775807);
    INSERT INTO activities (id, start_ms, end_ms, source, first_seen_at)
      VALUES (9223372036854775807, 7000, 8000, 'app', 15);

    INSERT INTO backup_files VALUES (9400101, 'metadata', 'activities/9400101/metadata/a.json',
      'aa', 3, 21);
    INSERT INTO backup_files VALUES (9007199254740993, 'streams',
      'activities/9007199254740993/streams.json', 'bb', 4, 22);
    INSERT INTO merge_groups (id, status, app_ids, fitbit_ids, start_ms, external_id,
      upload_id, merged_activity_id, deleted_ids, created_at, updated_at)
      VALUES ('g-1-synthetic', 'done', '[9400101]', '[9400102]', 1000, 'cameld-merge-g-1-synthetic',
      77000001, 9400401, '[9400101,9400102]', 1, 2);
    INSERT INTO group_events (group_id, at, from_status, to_status, event, evidence)
      VALUES ('g-1-synthetic', 1, NULL, 'detected', 'detected', '{}');
    INSERT INTO strava_writes (group_id, kind, target_id, status, result, created_at)
      VALUES ('g-1-synthetic', 'delete', 9400101, 'done', '{"confirmed":"api_404"}', 3);
  `);
  return { db, dir };
}

const ACTIVITY_COLUMNS = [
  "id",
  "name",
  "sport_type",
  "start_ms",
  "end_ms",
  "device_name",
  "external_id",
  "source",
  "is_merge_output",
  "first_seen_at",
  "backed_up_at",
  "original_status",
  "original_path",
  "original_format",
  "web_form_saved",
  "single_at",
  "gone_at",
  "restored_as",
  "restored_from",
  "original_attempts",
  "original_next_attempt_at",
  "original_evidence",
];

/** Every value of every row as text plus its storage class: nothing can change unseen. */
function dump(db: DatabaseSync, table: string, columns: readonly string[], order: string) {
  const cells = columns.map((c) => `CAST(${c} AS TEXT) AS ${c}, typeof(${c}) AS ${c}_type`);
  return db
    .prepare(`SELECT ${cells.join(", ")} FROM ${table} ORDER BY ${order}`)
    .all()
    .map((row) => ({ ...row }));
}

function columnsOf(db: DatabaseSync, table: string) {
  return db
    .prepare(`SELECT name, type, "notnull", dflt_value FROM pragma_table_info('${table}')`)
    .all()
    .map((row) => ({ ...row }));
}

function names(db: DatabaseSync, table: string): string[] {
  return columnsOf(db, table).map((c) => c.name as string);
}

describe("migration 0006: activities without a rowid", () => {
  it("knows every column of the table (the copy lists them by name)", () => {
    const { db } = databaseBefore();
    expect(names(db, "activities")).toEqual(ACTIVITY_COLUMNS);
    db.close();
  });

  it("carries every row and every value over exactly", () => {
    const { db, dir } = databaseBefore();
    const before = dump(db, "activities", ACTIVITY_COLUMNS, "id");
    expect(before).toHaveLength(6);
    const others = (): unknown => ({
      backup_files: dump(db, "backup_files", names(db, "backup_files"), "rowid"),
      merge_groups: dump(db, "merge_groups", names(db, "merge_groups"), "id"),
      group_events: dump(db, "group_events", names(db, "group_events"), "id"),
      strava_writes: dump(db, "strava_writes", names(db, "strava_writes"), "id"),
    });
    const othersBefore = others();
    const columnsBefore = columnsOf(db, "activities");

    writeFileSync(join(dir, MIGRATION), shipped(MIGRATION));
    expect(migrate(db, dir)).toEqual([MIGRATION]);

    expect(dump(db, "activities", ACTIVITY_COLUMNS, "id")).toEqual(before);
    // Same columns, types and defaults. The one difference: the key now reports
    // NOT NULL (a rowid key could not hold a null either, it just did not say so).
    expect(columnsOf(db, "activities")).toEqual(
      columnsBefore.map((column) => (column.name === "id" ? { ...column, notnull: 1 } : column)),
    );
    expect(others()).toEqual(othersBefore);
    // Spot checks in plain sight: the ids around 2^53 are still two activities.
    expect(
      db
        .prepare("SELECT CAST(id AS TEXT) AS id, CAST(restored_as AS TEXT) AS r FROM activities")
        .all()
        .map((row) => `${String(row.id)}>${String(row.r)}`),
    ).toEqual([
      "9400101>9400401",
      "9400102>null",
      "9400401>null",
      "9007199254740992>null",
      "9007199254740993>9223372036854775807",
      "9223372036854775807>null",
    ]);
    db.close();
  });

  it("leaves a strict table with the same key and index, and no rowid", () => {
    const { db, dir } = databaseBefore();
    writeFileSync(join(dir, MIGRATION), shipped(MIGRATION));
    migrate(db, dir);

    const table = db
      .prepare("SELECT wr, strict FROM pragma_table_list WHERE name = 'activities'")
      .get();
    expect({ ...table }).toEqual({ wr: 1, strict: 1 });
    expect(() => db.prepare("SELECT rowid FROM activities")).toThrow(/no such column/);
    expect(
      db.prepare("SELECT name FROM pragma_table_info('activities') WHERE pk > 0").all(),
    ).toEqual([{ name: "id" }]);
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE tbl_name = 'activities' ORDER BY name")
        .all()
        .map((row) => row.name),
    ).toContain("activities_start");
    // Nothing of the rebuild is left behind.
    expect(
      db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE '%without_rowid%'").get(),
    ).toEqual({ n: 0 });
    // The key still refuses a second row with the same id.
    expect(() =>
      db.exec(
        "INSERT INTO activities (id, start_ms, end_ms, source, first_seen_at) VALUES (9400101, 1, 2, 'app', 1)",
      ),
    ).toThrow(/UNIQUE|PRIMARY KEY/i);
    // Defaults and NOT NULL are those of the old table.
    db.exec(
      "INSERT INTO activities (id, start_ms, end_ms, source, first_seen_at) VALUES (9400999, 1, 2, 'app', 1)",
    );
    expect(requireActivity(db, "9400999")).toMatchObject({
      isMergeOutput: false,
      originalStatus: "pending",
      originalAttempts: 0,
      webFormSaved: false,
    });
    expect(() => db.exec("INSERT INTO activities (id) VALUES (9400998)")).toThrow(/NOT NULL/);
    db.close();
  });

  it("reads the migrated rows through the repo, old ids and 64-bit ones alike", () => {
    const { db, dir } = databaseBefore();
    writeFileSync(join(dir, MIGRATION), shipped(MIGRATION));
    migrate(db, dir);
    expect(requireActivity(db, "9400101")).toMatchObject({
      id: "9400101",
      name: "Synthetic Loop",
      restoredAs: "9400401",
      originalAttempts: 2,
      originalNextAttemptAt: 50,
      webFormSaved: true,
    });
    expect(requireActivity(db, "9007199254740993").restoredAs).toBe("9223372036854775807");
    expect(requireActivity(db, "9007199254740992").restoredAs).toBeNull();
    setActivityFields(db, "9007199254740993", { gone_at: 99 });
    expect(requireActivity(db, "9007199254740993").goneAt).toBe(99);
    expect(requireActivity(db, "9007199254740992").goneAt).toBeNull();
    db.close();
  });
});

describe("a 64-bit activity id never becomes the connection's last insert rowid", () => {
  // The trap 0006 removes: node:sqlite reports last_insert_rowid from EVERY
  // statement.run(), and newer Node throws when it does not fit a number.
  it("leaves last_insert_rowid alone when an activity is inserted", () => {
    const db = memoryDb();
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('k', 'v', 'now')").run();
    const before = db.prepare("SELECT CAST(last_insert_rowid() AS TEXT) AS id").get();
    upsertActivity(
      db,
      {
        id: "9100000000000000101",
        name: "Synthetic",
        sport_type: "Run",
        start_date: "2020-02-02T10:00:00Z",
        start_date_local: "2020-02-02T10:00:00Z",
        distance: 1,
        moving_time: 1,
        elapsed_time: 1,
      },
      1,
    );
    expect(db.prepare("SELECT CAST(last_insert_rowid() AS TEXT) AS id").get()).toEqual(before);
    // And an unrelated write afterwards works and reports ordinary numbers.
    const result = db.prepare("UPDATE settings SET value = 'w' WHERE key = 'k'").run();
    expect(result.changes).toBe(1);
    expect(typeof result.lastInsertRowid).toBe("number");
    expect(Number.isSafeInteger(result.lastInsertRowid)).toBe(true);
    db.close();
  });
});
