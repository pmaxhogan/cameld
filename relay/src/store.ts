/**
 * D1 access for the `codes` table. Takes the structural subset of
 * D1Database it uses, so tests can drive the real SQL through node:sqlite.
 */
import { domainAllowed, type MailKind, TTL_MS } from "./classify.ts";
import { open, seal } from "./crypto.ts";

export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
}

export interface SqlDb {
  prepare(sql: string): SqlStatement;
}

interface CodeRow {
  id: string;
  kind: MailKind;
  sender_domain: string;
  received_at: number;
  payload_enc: string | null;
}

interface Payload {
  code: string | null;
  url: string | null;
}

export interface ClaimedCode {
  code: string;
  receivedAt: number;
}

export interface ForwardConfirmation {
  code: string | null;
  url: string | null;
  receivedAt: number;
}

export interface NewEntry {
  kind: MailKind;
  senderDomain: string;
  subject: string;
  code: string | null;
  url: string | null;
  receivedAt: number;
}

const payloadAad = (id: string): string => `codes.payload_enc.${id}`;
const subjectAad = (id: string): string => `codes.subject_enc.${id}`;

/** How many candidate rows a claim looks at before giving up. */
const CLAIM_CANDIDATES = 25;
/** Consumed rows are kept this long after expiry for debugging, then purged. */
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;

export class CodeStore {
  readonly #db: SqlDb;
  readonly #key: CryptoKey;
  readonly #newId: () => string;

  constructor(db: SqlDb, key: CryptoKey, newId: () => string = () => crypto.randomUUID()) {
    this.#db = db;
    this.#key = key;
    this.#newId = newId;
  }

  async insert(entry: NewEntry): Promise<string> {
    const id = this.#newId();
    const payload =
      entry.kind === "other"
        ? null
        : await seal(
            this.#key,
            JSON.stringify({ code: entry.code, url: entry.url } satisfies Payload),
            payloadAad(id),
          );
    const subject =
      entry.subject === "" ? null : await seal(this.#key, entry.subject, subjectAad(id));
    await this.#db
      .prepare(
        `INSERT INTO codes (id, kind, sender_domain, received_at, expires_at, payload_enc, subject_enc)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        entry.kind,
        entry.senderDomain,
        entry.receivedAt,
        entry.receivedAt + TTL_MS[entry.kind],
        payload,
        subject,
      )
      .run();
    return id;
  }

  /**
   * Atomically claim the OLDEST unconsumed, unexpired OTP from `sender` (label
   * anchored) received strictly after `since`. Oldest-first plus the `since`
   * floor means neither a stale code nor a later flood can win the race.
   */
  async claimOtp(sender: string, since: number, now: number): Promise<ClaimedCode | null> {
    for (let i = 0; i < CLAIM_CANDIDATES; i += 1) {
      const row = await this.#db
        .prepare(
          `UPDATE codes SET consumed_at = ?1
            WHERE id = (
              SELECT id FROM codes
               WHERE kind = 'otp' AND consumed_at IS NULL AND expires_at > ?1 AND received_at > ?2
                 AND (sender_domain = ?3 OR sender_domain LIKE '%.' || ?3)
               ORDER BY received_at ASC, id ASC LIMIT 1)
              AND consumed_at IS NULL
          RETURNING id, kind, sender_domain, received_at, payload_enc`,
        )
        .bind(now, since, sender)
        .first<CodeRow>();
      if (row === null) return null;
      // The SQL LIKE is only a prefilter; re-check with the exact rule.
      if (!domainAllowed(row.sender_domain, [sender]) || row.payload_enc === null) continue;
      const payload = await this.#openPayload(row);
      if (payload.code === null) continue;
      return { code: payload.code, receivedAt: row.received_at };
    }
    return null;
  }

  /** Claim the newest unexpired Gmail forwarding confirmation, once. */
  async claimForwardConfirmation(now: number): Promise<ForwardConfirmation | null> {
    const row = await this.#db
      .prepare(
        `UPDATE codes SET consumed_at = ?1
          WHERE id = (
            SELECT id FROM codes
             WHERE kind = 'forward_verify' AND consumed_at IS NULL AND expires_at > ?1
             ORDER BY received_at DESC, id DESC LIMIT 1)
            AND consumed_at IS NULL
        RETURNING id, kind, sender_domain, received_at, payload_enc`,
      )
      .bind(now)
      .first<CodeRow>();
    if (row === null || row.payload_enc === null) return null;
    const payload = await this.#openPayload(row);
    return { code: payload.code, url: payload.url, receivedAt: row.received_at };
  }

  async purge(now: number): Promise<void> {
    await this.#db
      .prepare(`DELETE FROM codes WHERE expires_at <= ? - ?`)
      .bind(now, RETAIN_MS)
      .run();
    // Unclaimed secrets past their TTL are dropped right away.
    await this.#db
      .prepare(
        `UPDATE codes SET payload_enc = NULL, kind = 'other' WHERE expires_at <= ? AND payload_enc IS NOT NULL`,
      )
      .bind(now)
      .run();
  }

  async #openPayload(row: CodeRow): Promise<Payload> {
    return JSON.parse(await open(this.#key, row.payload_enc ?? "", payloadAad(row.id))) as Payload;
  }
}
