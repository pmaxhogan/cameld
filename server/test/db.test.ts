import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, MigrationError, migrate, openDatabase } from "../src/db.ts";

const cleanup: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cameld-db-"));
  cleanup.push(dir);
  return dir;
}

function migrationsDir(files: Record<string, string>): string {
  const dir = join(tempDir(), "migrations");
  mkdirSync(dir);
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("migrate", () => {
  it("applies the shipped migrations and is idempotent", () => {
    const db = openDatabase(":memory:");
    expect(migrate(db, MIGRATIONS_DIR)).toEqual([
      "0001_settings.sql",
      "0002_strava_tokens.sql",
      "0003_merge_state.sql",
      "0004_ui.sql",
      "0005_original_retries.sql",
    ]);
    expect(migrate(db, MIGRATIONS_DIR)).toEqual([]);
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(
      "k",
      "v",
      "now",
    );
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("k");
    expect(row?.value).toBe("v");
    db.close();
  });

  it("creates the database file and parent directories on disk", () => {
    const path = join(tempDir(), "nested", "state", "cameld.db");
    const db = openDatabase(path);
    expect(migrate(db, MIGRATIONS_DIR)).toHaveLength(5);
    db.close();
  });

  it("renames the old 'none' original status to 'unavailable' and adds retry columns", () => {
    const shipped = (name: string): string => readFileSync(join(MIGRATIONS_DIR, name), "utf8");
    const first = [
      "0001_settings.sql",
      "0002_strava_tokens.sql",
      "0003_merge_state.sql",
      "0004_ui.sql",
    ];
    const dir = migrationsDir(Object.fromEntries(first.map((name) => [name, shipped(name)])));
    const db = openDatabase(":memory:");
    migrate(db, dir);
    const insert = db.prepare(
      `INSERT INTO activities (id, start_ms, end_ms, source, first_seen_at, original_status)
       VALUES (?, 0, 1, 'other', 0, ?)`,
    );
    insert.run(1, "none");
    insert.run(2, "present");
    insert.run(3, "pending");
    writeFileSync(join(dir, "0005_original_retries.sql"), shipped("0005_original_retries.sql"));
    expect(migrate(db, dir)).toEqual(["0005_original_retries.sql"]);
    expect(
      db
        .prepare(
          "SELECT id, original_status, original_attempts, original_next_attempt_at FROM activities ORDER BY id",
        )
        .all()
        .map((row) => ({ ...row })),
    ).toEqual([
      {
        id: 1,
        original_status: "unavailable",
        original_attempts: 0,
        original_next_attempt_at: null,
      },
      { id: 2, original_status: "present", original_attempts: 0, original_next_attempt_at: null },
      { id: 3, original_status: "pending", original_attempts: 0, original_next_attempt_at: null },
    ]);
    db.close();
  });

  it("applies new migrations appended later, in order", () => {
    const dir = migrationsDir({ "0001_a.sql": "CREATE TABLE a (id INTEGER);" });
    const db = openDatabase(":memory:");
    expect(migrate(db, dir)).toEqual(["0001_a.sql"]);
    writeFileSync(join(dir, "0002_b.sql"), "CREATE TABLE b (id INTEGER);");
    expect(migrate(db, dir)).toEqual(["0002_b.sql"]);
    db.close();
  });

  it("refuses an applied migration that was edited", () => {
    const dir = migrationsDir({ "0001_a.sql": "CREATE TABLE a (id INTEGER);" });
    const db = openDatabase(":memory:");
    migrate(db, dir);
    writeFileSync(join(dir, "0001_a.sql"), "CREATE TABLE a (id INTEGER, extra TEXT);");
    expect(() => migrate(db, dir)).toThrow(/modified after it was applied/);
    db.close();
  });

  it("refuses an applied migration that disappeared", () => {
    const dir = migrationsDir({ "0001_a.sql": "CREATE TABLE a (id INTEGER);" });
    const db = openDatabase(":memory:");
    migrate(db, dir);
    rmSync(join(dir, "0001_a.sql"));
    expect(() => migrate(db, dir)).toThrow(MigrationError);
    db.close();
  });

  it("rolls back a failing migration and does not record it", () => {
    const dir = migrationsDir({
      "0001_bad.sql": "CREATE TABLE ok (id INTEGER); INSERT INTO missing VALUES (1);",
    });
    const db = openDatabase(":memory:");
    expect(() => migrate(db, dir)).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok'").all()).toEqual([]);
    expect(db.prepare("SELECT count(*) AS n FROM schema_migrations").get()?.n).toBe(0);
    db.close();
  });

  it("rejects badly named and duplicate-numbered files", () => {
    const db = openDatabase(":memory:");
    expect(() => migrate(db, migrationsDir({ "bad.sql": "SELECT 1;" }))).toThrow(/must be named/);
    expect(() =>
      migrate(db, migrationsDir({ "0001_a.sql": "SELECT 1;", "0001_b.sql": "SELECT 2;" })),
    ).toThrow(/Duplicate/);
    db.close();
  });
});
