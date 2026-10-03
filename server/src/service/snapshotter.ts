/**
 * ZFS snapshots of the backup dataset (ARCHITECTURE.md section 7). The
 * service never holds a privileged container or the Docker socket; it asks a
 * tiny host-side helper at SNAPSHOT_HELPER_URL:
 *
 *   POST <SNAPSHOT_HELPER_URL>/snapshot
 *   content-type: application/json
 *   {"label": "<a-z 0-9 - _, at most 64 chars>"}
 *
 *   200 {"snapshot": "<dataset>@<name>"}   the snapshot exists
 *   anything else                           no snapshot; cameld refuses to delete
 *
 * The helper snapshots one fixed dataset only and takes nothing else from the
 * request. Without SNAPSHOT_HELPER_URL every snapshot fails, which parks
 * every delete (UnavailableSnapshotter).
 */

export interface Snapshotter {
  /** Take a snapshot and return its full name. Throws SnapshotError on any failure. */
  snapshot(label: string): Promise<string>;
}

export class SnapshotError extends Error {
  override readonly name = "SnapshotError";
}

const LABEL = /^[a-z0-9_-]{1,64}$/;

export function assertLabel(label: string): void {
  if (!LABEL.test(label)) throw new SnapshotError("snapshot label must match [a-z0-9_-]{1,64}");
}

export interface HttpSnapshotterOptions {
  url: string;
  fetch?: typeof fetch;
  /** Default 60000: a snapshot of a large dataset is still quick, but not instant. */
  timeoutMs?: number;
}

export class HttpSnapshotter implements Snapshotter {
  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: HttpSnapshotterOptions) {
    this.#url = `${options.url.replace(/\/+$/, "")}/snapshot`;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
  }

  async snapshot(label: string): Promise<string> {
    assertLabel(label);
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ label }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new SnapshotError(`snapshot helper unreachable: ${(error as Error).message}`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new SnapshotError(`snapshot helper answered ${response.status}`);
    }
    const body = (await response.json().catch(() => null)) as { snapshot?: unknown } | null;
    const name = body?.snapshot;
    if (typeof name !== "string" || !/^[^@\s]+@[^@\s]+$/.test(name)) {
      throw new SnapshotError("snapshot helper did not return a snapshot name");
    }
    return name;
  }
}

/** Used when SNAPSHOT_HELPER_URL is not configured: nothing can be deleted. */
export class UnavailableSnapshotter implements Snapshotter {
  snapshot(label: string): Promise<string> {
    assertLabel(label);
    return Promise.reject(new SnapshotError("no snapshot helper configured"));
  }
}
