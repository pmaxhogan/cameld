import { CSRF_HEADER, CSRF_HEADER_VALUE } from "@cameld/shared";

/** A failed /api call: HTTP status plus the server's `{error, detail?}` body. */
export class ApiFailure extends Error {
  readonly status: number;
  readonly error: string;
  readonly detail: string | undefined;

  constructor(status: number, error: string, detail?: string) {
    super(detail === undefined ? error : `${error}: ${detail}`);
    this.name = "ApiFailure";
    this.status = status;
    this.error = error;
    this.detail = detail;
  }
}

const writeListeners = new Set<() => void>();

/** Runs `listener` after every successful write. Returns an unsubscribe function. */
export function onWrite(listener: () => void): () => void {
  writeListeners.add(listener);
  return () => writeListeners.delete(listener);
}

/** The backup-password session is gone: hand the owner to the login page. */
export function toLogin(): void {
  location.assign("/login");
}

async function failureOf(response: Response): Promise<ApiFailure> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const error = typeof record.error === "string" ? record.error : `http_${response.status}`;
  const detail = typeof record.detail === "string" ? record.detail : undefined;
  return new ApiFailure(response.status, error, detail);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const write = method !== "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (write) {
    headers[CSRF_HEADER] = CSRF_HEADER_VALUE;
    headers["content-type"] = "application/json";
  }
  const response = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: write ? JSON.stringify(body ?? {}) : undefined,
  });
  if (response.status === 401) {
    toLogin();
    throw new ApiFailure(401, "unauthorized");
  }
  if (!response.ok) throw await failureOf(response);
  const data = (response.status === 204 ? undefined : await response.json()) as T;
  if (write) for (const listener of writeListeners) listener();
  return data;
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>("GET", path);
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>("POST", path, body);
}

export function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return request<T>("PATCH", path, body);
}

/** A one-line, owner-readable description of any thrown value. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** True when `error` is an ApiFailure carrying the given error code. */
export function isFailure(error: unknown, code: string): boolean {
  return error instanceof ApiFailure && error.error === code;
}
