/**
 * Code that runs INSIDE the browser page via `page.evaluate`. Playwright
 * serializes these functions' source, so each must be self-contained: no
 * imports, no closures over module scope, no helpers defined elsewhere.
 *
 * Kept deliberately tiny and logic-free (all decisions happen in Node, in
 * forms.ts and classify.ts). This file is excluded from unit coverage in
 * vitest.config.ts because v8 never sees it execute in Node; the integration
 * tests against the fake Strava server exercise it in a real Chromium.
 */

/** Minimal DOM surface used below; the server tsconfig has no DOM lib. */
interface MiniElement {
  getAttribute(name: string): string | null;
  querySelector(selector: string): MiniElement | null;
}
interface MiniForm extends MiniElement {
  action: string;
}
declare const document: {
  querySelector(selector: string): MiniElement | null;
  querySelectorAll(selector: string): Iterable<MiniForm>;
};
declare const location: { href: string };
declare const FormData: {
  new (form: MiniForm): Iterable<[string, unknown]>;
};

export type InPageBody =
  | { kind: "none" }
  | { kind: "form"; entries: [string, string][] }
  | { kind: "json"; text: string }
  | { kind: "bytes"; base64: string };

export interface InPageRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: InPageBody;
  credentials: "include" | "omit";
}

export interface InPageResponse {
  status: number;
  /** Final URL after redirects. */
  url: string;
  redirected: boolean;
  headers: Record<string, string>;
  bodyBase64: string;
}

/** fetch() from the page, so the request carries the session cookies and origin. */
export async function inPageFetch(request: InPageRequest): Promise<InPageResponse> {
  let body: RequestInit["body"];
  if (request.body.kind === "form") body = new URLSearchParams(request.body.entries);
  else if (request.body.kind === "json") body = request.body.text;
  else if (request.body.kind === "bytes")
    body = Uint8Array.from(atob(request.body.base64), (c) => c.charCodeAt(0));
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    credentials: request.credentials,
    redirect: "follow",
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return {
    status: response.status,
    url: response.url,
    redirected: response.redirected,
    headers,
    bodyBase64: btoa(binary),
  };
}

export interface FormSnapshot {
  /** Exactly what the browser would submit (FormData order), files skipped. */
  entries: [string, string][];
  /** `meta[name=csrf-token]`, when the page has one. */
  csrfToken: string | null;
}

/**
 * Read the Rails form that PATCHes `activityPath` (the one carrying an
 * authenticity_token). Null when the page has no such form.
 */
export function readActivityForm(activityPath: string): FormSnapshot | null {
  let form: MiniForm | null = null;
  for (const candidate of document.querySelectorAll("form")) {
    const path = new URL(candidate.action, location.href).pathname;
    if (path === activityPath && candidate.querySelector('input[name="authenticity_token"]')) {
      form = candidate;
      break;
    }
  }
  if (form === null) return null;
  const entries: [string, string][] = [];
  for (const [name, value] of new FormData(form)) {
    if (typeof value === "string") entries.push([name, value]);
  }
  const meta = document.querySelector('meta[name="csrf-token"]');
  return { entries, csrfToken: meta === null ? null : meta.getAttribute("content") };
}
