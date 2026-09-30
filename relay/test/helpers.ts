import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import type { SqlDb, SqlStatement } from "../src/store.ts";

/** A D1-shaped wrapper over an in-memory node:sqlite database with the real migration applied. */
export function memoryDb(): SqlDb & { raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  raw.exec(
    readFileSync(
      fileURLToPath(new URL("../migrations/0001_codes.sql", import.meta.url).href),
      "utf8",
    ),
  );
  const statement = (sql: string, values: unknown[]): SqlStatement => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: <T>() => {
      const row = raw.prepare(sql).get(...(values as never[]));
      return Promise.resolve((row ?? null) as T | null);
    },
    run: () => Promise.resolve(raw.prepare(sql).run(...(values as never[]))),
  });
  return { raw, prepare: (sql: string) => statement(sql, []) };
}

/** A fixed, test-only AES key (base64 of 32 bytes). Never a real secret. */
export const TEST_DATA_KEY = Buffer.alloc(32, 7).toString("base64");

/** Build a synthetic RFC 822 message. */
export function rawMail(options: {
  from: string;
  subject: string;
  text?: string;
  html?: string;
}): string {
  const headers = [
    `From: Sender <${options.from}>`,
    "To: 2fa@relay.example.test",
    `Subject: ${options.subject}`,
    "Message-ID: <synthetic-1@example.test>",
    "MIME-Version: 1.0",
  ];
  if (options.html !== undefined) {
    return [...headers, "Content-Type: text/html; charset=utf-8", "", options.html].join("\r\n");
  }
  return [...headers, "Content-Type: text/plain; charset=utf-8", "", options.text ?? ""].join(
    "\r\n",
  );
}
