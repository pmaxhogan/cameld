import type { DatabaseSync } from "node:sqlite";
import { Writable } from "node:stream";
import { migrate, openDatabase } from "../src/db.ts";
import { createLogger, type Logger } from "../src/logging.ts";
import type { Notification, Notifier } from "../src/service/notifier.ts";
import { SnapshotError, type Snapshotter } from "../src/service/snapshotter.ts";

/** A migrated in-memory database. */
export function memoryDb(): DatabaseSync {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

export class RecordingNotifier implements Notifier {
  readonly sent: Notification[] = [];
  fail = false;
  notify(notification: Notification): Promise<void> {
    if (this.fail) return Promise.reject(new Error("push service down"));
    this.sent.push(notification);
    return Promise.resolve();
  }
  kinds(): string[] {
    return this.sent.map((n) => n.kind);
  }
}

/** Snapshotter fake. `onSnapshot` can advance a fake clock to simulate a slow snapshot. */
export class FakeSnapshotter implements Snapshotter {
  readonly taken: string[] = [];
  fail = false;
  onSnapshot: (() => void) | undefined;
  snapshot(label: string): Promise<string> {
    if (this.fail) return Promise.reject(new SnapshotError("synthetic snapshot failure"));
    this.onSnapshot?.();
    const name = `tank/cameld@${label}-${this.taken.length + 1}`;
    this.taken.push(name);
    return Promise.resolve(name);
  }
}

/** A logger that collects NDJSON lines. */
export function captureLogger(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const log = createLogger(
    { logLevel: "debug" },
    new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    }),
  );
  return { log, lines };
}
