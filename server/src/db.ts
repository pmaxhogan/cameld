import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

/** Default migrations directory: server/migrations, next to both src/ and dist/. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

export class MigrationError extends Error {
  override readonly name = "MigrationError";
}

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

function readMigrations(dir: string): MigrationFile[] {
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const seen = new Set<string>();
  return names.map((name) => {
    const match = MIGRATION_FILE.exec(name);
    if (match === null) {
      throw new MigrationError(`Migration "${name}" must be named NNNN_snake_case.sql`);
    }
    const prefix = match[1] as string;
    if (seen.has(prefix)) throw new MigrationError(`Duplicate migration number ${prefix}`);
    seen.add(prefix);
    const sql = readFileSync(`${dir}/${name}`, "utf8");
    return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  });
}

/**
 * Apply pending migrations in order, each in its own transaction. Migrations
 * are append-only: an applied migration whose file has changed or gone missing
 * is an error, never silently ignored. Returns the names applied this call.
 */
export function migrate(db: DatabaseSync, dir: string = MIGRATIONS_DIR): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    checksum   TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT`);

  const files = readMigrations(dir);
  const rows = db.prepare("SELECT name, checksum FROM schema_migrations").all() as {
    name: string;
    checksum: string;
  }[];
  const applied = new Map(rows.map((row) => [row.name, row.checksum]));

  for (const name of applied.keys()) {
    if (!files.some((file) => file.name === name)) {
      throw new MigrationError(`Applied migration "${name}" is missing from ${dir}`);
    }
  }

  const done: string[] = [];
  for (const file of files) {
    const recorded = applied.get(file.name);
    if (recorded !== undefined) {
      if (recorded !== file.checksum) {
        throw new MigrationError(
          `Migration "${file.name}" was modified after it was applied. Add a new migration instead.`,
        );
      }
      continue;
    }
    db.exec("BEGIN");
    try {
      db.exec(file.sql);
      db.prepare("INSERT INTO schema_migrations (name, checksum, applied_at) VALUES (?, ?, ?)").run(
        file.name,
        file.checksum,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    done.push(file.name);
  }
  return done;
}
