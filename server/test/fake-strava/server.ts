import { randomBytes, randomInt } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import { type FakeActivity, SYNTHETIC_PNG, syntheticActivities } from "./fixtures.ts";

/**
 * A minimal, Rails-flavoured stand-in for the strava.com web pages that
 * WebSession drives (docs/STRAVA-WEB.md). Synthetic data only.
 *
 * It is deliberately strict where the real site could hurt us:
 * - A PATCH resets every known field that is missing from the submission
 *   (and drops photos whose entries are missing), so a client that does not
 *   send back the whole form visibly destroys data.
 * - Every page carries a Log Out link with `data-method=delete`; any request
 *   to /session is recorded so tests can assert it never happens.
 * - The CSRF token must match the session.
 */

export type FakeMode =
  | "normal"
  /** Protected pages answer 200 with a captcha interstitial. */
  | "captcha"
  | "forbidden"
  | "rate_limited"
  | "otp_refused"
  /** The edit page hangs for `slowMs`. */
  | "slow_edit"
  /** PATCH answers like a success but saves nothing. */
  | "ignore_patch"
  /** PATCH also flips hide_from_home (a side effect the client must notice). */
  | "patch_side_effect"
  /** DELETE answers like a success but the activity stays. */
  | "keep_after_delete"
  /** DELETE answers 500 and deletes nothing. */
  | "delete_fails"
  /** DELETE succeeds, then every session expires (the check hits /login). */
  | "expire_after_delete"
  /** DELETE succeeds, then the check is challenged with a captcha. */
  | "captcha_after_delete"
  /** DELETE succeeds, then the activity URL redirects to an unrelated page. */
  | "odd_redirect_after_delete"
  /** The edit page has no csrf-token meta tag (the form token is used). */
  | "no_meta"
  /** The dashboard answers 500. */
  | "server_error"
  /** The dashboard has no athlete menu. */
  | "no_menu"
  /** export_original answers an HTML page. */
  | "export_html"
  /** The edit page has no activity form. */
  | "no_form"
  /** PUT /photos/metadata answers something that is not an upload target. */
  | "bad_metadata"
  /** Attached photos never show up on the edit form. */
  | "hide_new_photos"
  /**
   * Like Strava's React edit page: the visibility radios are missing from
   * the HTML and injected by script `hydrateMs` after load.
   */
  | "late_hydration"
  /** The visibility radios never appear (the page never hydrates). */
  | "never_hydrates";

export interface RecordedRequest {
  method: string;
  path: string;
  /** Form entries for urlencoded bodies, parsed JSON, or byte length. */
  body: unknown;
}

interface PendingUpload {
  signature: string;
  bytes: Buffer | null;
}

export interface FakeStrava {
  baseUrl: string;
  mode: FakeMode;
  slowMs: number;
  /** Delay before the late_hydration script injects the visibility radios. */
  hydrateMs: number;
  activities: Map<number, FakeActivity>;
  requests: RecordedRequest[];
  /** Login codes "emailed" by request_otp, newest last. */
  mailbox: { code: string; at: number }[];
  /** Set false to make verify_otp reject every code. */
  acceptCodes: boolean;
  /** Log a browser in: navigate a page to this URL. */
  sessionUrl: string;
  expireSessions(): void;
  close(): Promise<void>;
}

const SESSION_COOKIE = "fake_strava_session";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function layout(title: string, body: string, csrf: string | null, menu = true): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)} | Fake Strava</title>
${csrf === null ? "" : `<meta name="csrf-token" content="${csrf}">`}
</head><body>
<header><nav><ul>
${menu ? '<li class="user-menu"><a href="/athletes/424242">Synthetic Athlete</a></li>' : ""}
<li><a data-method="delete" href="/session" rel="nofollow">Log Out</a></li>
</ul></nav></header>
<main>${body}</main>
</body></html>`;
}

const CHALLENGE_PAGE = `<!doctype html><html><head><title>Security check</title></head>
<body><div class="g-recaptcha" data-sitekey="synthetic"></div><p>Please verify you are human.</p></body></html>`;

function checkbox(name: string, checked: boolean): string {
  return `<input type="hidden" name="${name}" value="0"><input type="checkbox" name="${name}" value="1"${checked ? " checked" : ""}>`;
}

function option(value: string, current: string, label = value): string {
  return `<option value="${value}"${value === current ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

function radios(name: string, values: string[], current: string): string {
  return values
    .map(
      (v) =>
        `<label><input type="radio" name="${name}" value="${v}"${v === current ? " checked" : ""}> ${v}</label>`,
    )
    .join("");
}

type Hydration = "server" | "late" | "never";

function editPage(
  activity: FakeActivity,
  csrf: string,
  withForm: boolean,
  withMeta: boolean,
  hydration: Hydration = "server",
  hydrateMs = 0,
): string {
  const visibility = radios(
    "activity[visibility]",
    ["everyone", "followers_only", "only_me"],
    activity.visibility,
  );
  // An inert <template> is not part of FormData until the script clones it.
  const visibilityHtml =
    hydration === "server"
      ? visibility
      : `<span id="visibility-slot"></span><template id="visibility-template">${visibility}</template>`;
  const script =
    hydration === "late"
      ? `<script>setTimeout(() => {
  const template = document.getElementById("visibility-template");
  document.getElementById("visibility-slot").appendChild(template.content.cloneNode(true));
}, ${hydrateMs});</script>`
      : "";
  const photos = activity.photos
    .map(
      (p) =>
        `<input type="hidden" name="photos[${p.uuid}][rank]" value="${p.rank}">` +
        `<input type="hidden" name="photos[${p.uuid}][media_type]" value="${p.mediaType}">` +
        `<input type="hidden" name="photos[${p.uuid}][caption]" value="${escapeHtml(p.caption)}">`,
    )
    .join("\n");
  const exertion = ["", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]
    .map((v) => option(v, activity.perceivedExertion, v === "" ? "Not set" : v))
    .join("");
  const form = `<form id="search" action="/search" method="get"><input name="q" value=""></form>
<form class="edit_activity" action="/activities/${activity.id}" method="post" accept-charset="UTF-8">
<input type="hidden" name="_method" value="patch">
<input type="hidden" name="authenticity_token" value="${csrf}">
<input type="text" name="activity[name]" value="${escapeHtml(activity.name)}">
<textarea name="activity[description]">${escapeHtml(activity.description)}</textarea>
<select name="activity[sport_type]">${["Run", "Ride", "Walk", "Hike"].map((v) => option(v, activity.sportType)).join("")}</select>
<textarea name="activity[private_note]">${escapeHtml(activity.privateNote)}</textarea>
${visibilityHtml}
<select name="activity[perceived_exertion]">${exertion}</select>
${checkbox("activity[prefer_perceived_exertion]", activity.preferPerceivedExertion)}
${checkbox("activity[hide_from_home]", activity.hideFromHome)}
${checkbox("activity[commute]", activity.commute)}
${photos}
<input type="file" name="activity[photo_file]">
<button type="submit" name="commit" value="Save">Save</button>
</form>
<a data-method="delete" data-confirm="Are you sure?" href="/activities/${activity.id}" rel="nofollow">Delete</a>
${script}`;
  return layout(
    `Edit ${activity.name}`,
    withForm ? form : "<p>Edit is unavailable.</p>",
    withMeta ? csrf : null,
  );
}

const LOGIN_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Log In | Fake Strava</title></head><body>
<form id="email-form"><input type="email" name="email" autocomplete="username"><button type="submit">Send code</button></form>
<p id="error" hidden>Something went wrong.</p>
<form id="otp-form" method="post" action="/login/verify_otp" style="display:none">
<input type="text" name="otp" autocomplete="one-time-code"><button type="submit">Log in</button></form>
<script>
document.getElementById("email-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = event.target.elements.email.value;
  const response = await fetch("/login/request_otp", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }),
  });
  if (response.ok) document.getElementById("otp-form").style.display = "block";
  else document.getElementById("error").hidden = false;
});
</script></body></html>`;

/** Rails: last value of a repeated name wins. */
function last(entries: [string, string][], name: string): string | undefined {
  let value: string | undefined;
  for (const [key, v] of entries) if (key === name) value = v;
  return value;
}

function applyPatch(activity: FakeActivity, entries: [string, string][], uploaded: Set<string>) {
  activity.name = last(entries, "activity[name]") ?? "";
  activity.description = last(entries, "activity[description]") ?? "";
  activity.sportType = last(entries, "activity[sport_type]") ?? "Workout";
  activity.privateNote = last(entries, "activity[private_note]") ?? "";
  activity.visibility = last(entries, "activity[visibility]") ?? "everyone";
  activity.perceivedExertion = last(entries, "activity[perceived_exertion]") ?? "";
  activity.preferPerceivedExertion = last(entries, "activity[prefer_perceived_exertion]") === "1";
  activity.hideFromHome = last(entries, "activity[hide_from_home]") === "1";
  activity.commute = last(entries, "activity[commute]") === "1";
  const photos = new Map<string, { rank: number; mediaType: number; caption: string }>();
  for (const [key, value] of entries) {
    const match = /^photos\[([^\]]+)\]\[(rank|media_type|caption)\]$/.exec(key);
    if (match === null) continue;
    const uuid = match[1] as string;
    const photo = photos.get(uuid) ?? { rank: 0, mediaType: 1, caption: "" };
    if (match[2] === "rank") photo.rank = Number(value);
    else if (match[2] === "media_type") photo.mediaType = Number(value);
    else photo.caption = value;
    photos.set(uuid, photo);
  }
  const known = new Set(activity.photos.map((p) => p.uuid));
  activity.photos = [...photos]
    .filter(([uuid]) => known.has(uuid) || uploaded.has(uuid))
    .map(([uuid, p]) => ({ uuid, ...p }));
}

export async function startFakeStrava(): Promise<FakeStrava> {
  const app: FastifyInstance = Fastify({ logger: false });
  const sessions = new Map<string, string>(); // session id -> csrf token
  const uploads = new Map<string, PendingUpload>();
  const uploaded = new Set<string>();
  let pendingCode: string | null = null;

  const fake: FakeStrava = {
    baseUrl: "",
    mode: "normal",
    slowMs: 5000,
    hydrateMs: 1500,
    activities: new Map(syntheticActivities().map((a) => [a.id, a])),
    requests: [],
    mailbox: [],
    acceptCodes: true,
    sessionUrl: "",
    expireSessions: () => sessions.clear(),
    close: () => app.close(),
  };

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => done(null, [...new URLSearchParams(body as string)]),
  );
  app.addContentTypeParser(
    ["application/octet-stream", "image/png", "image/jpeg"],
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );
  app.addHook("preHandler", async (request) => {
    fake.requests.push({
      method: request.method,
      path: request.url.split("?")[0] as string,
      body: Buffer.isBuffer(request.body) ? request.body.length : request.body,
    });
  });

  function sessionOf(request: FastifyRequest): { id: string; csrf: string } | null {
    const header = request.headers.cookie ?? "";
    for (const part of header.split(";")) {
      const [name, value] = part.trim().split("=");
      if (name === SESSION_COOKIE && value !== undefined) {
        const csrf = sessions.get(value);
        if (csrf !== undefined) return { id: value, csrf };
      }
    }
    return null;
  }

  function startSession(reply: FastifyReply): void {
    const id = randomBytes(12).toString("hex");
    sessions.set(id, randomBytes(16).toString("base64url"));
    reply.header("set-cookie", `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax`);
  }

  /** Mode gates and the login redirect shared by every protected route. */
  function guard(request: FastifyRequest, reply: FastifyReply): { csrf: string } | null {
    if (fake.mode === "rate_limited") {
      void reply.code(429).type("text/plain").send("Too Many Requests");
      return null;
    }
    if (fake.mode === "forbidden") {
      void reply.code(403).type("text/html").send("<html><body>Forbidden</body></html>");
      return null;
    }
    if (fake.mode === "captcha") {
      void reply.code(200).type("text/html").send(CHALLENGE_PAGE);
      return null;
    }
    const session = sessionOf(request);
    if (session === null) {
      void reply.redirect("/login");
      return null;
    }
    return session;
  }

  function activityOr404(id: string, reply: FastifyReply): FakeActivity | null {
    const activity = fake.activities.get(Number(id));
    if (activity?.redirectWhenGone === true) {
      void reply.redirect("/features");
      return null;
    }
    if (activity === undefined || !activity.exists) {
      void reply
        .code(404)
        .type("text/html")
        .send(layout("Not Found", "<p>Not found</p>", null));
      return null;
    }
    return activity;
  }

  // Test-only: logs the visiting browser in.
  app.get("/__test/session", (_request, reply) => {
    startSession(reply);
    return reply.redirect("/dashboard");
  });

  app.get("/login", (request, reply) => {
    if (fake.mode === "captcha") return reply.type("text/html").send(CHALLENGE_PAGE);
    // Like the real site, a logged-in browser is sent on to the dashboard.
    if (sessionOf(request) !== null) return reply.redirect("/dashboard");
    return reply.type("text/html").send(LOGIN_PAGE);
  });

  app.post("/login/request_otp", (_request, reply) => {
    if (fake.mode === "otp_refused") return reply.code(403).send({ error: "recaptcha" });
    pendingCode = String(randomInt(0, 1_000_000)).padStart(6, "0");
    fake.mailbox.push({ code: pendingCode, at: Date.now() });
    return reply.send({ sent: true });
  });

  app.post("/login/verify_otp", (request, reply) => {
    const entries = request.body as [string, string][];
    if (fake.acceptCodes && pendingCode !== null && last(entries, "otp") === pendingCode) {
      pendingCode = null;
      startSession(reply);
      return reply.redirect("/dashboard");
    }
    return reply.redirect("/login?error=1");
  });

  app.route({
    method: ["DELETE", "POST", "GET"],
    url: "/session",
    handler: (request, reply) => {
      const session = sessionOf(request);
      if (session !== null) sessions.delete(session.id);
      return reply.redirect("/login");
    },
  });

  app.get("/dashboard", (request, reply) => {
    const session = guard(request, reply);
    if (session === null) return reply;
    if (fake.mode === "server_error") return reply.code(500).type("text/plain").send("oops");
    const body = "<h1>Dashboard</h1><p>Synthetic feed.</p>";
    return reply
      .type("text/html")
      .send(layout("Dashboard", body, session.csrf, fake.mode !== "no_menu"));
  });

  app.get<{ Params: { id: string } }>("/activities/:id", (request, reply) => {
    const session = guard(request, reply);
    if (session === null) return reply;
    const activity = activityOr404(request.params.id, reply);
    if (activity === null) return reply;
    return reply
      .type("text/html")
      .send(layout(activity.name, `<h1>${escapeHtml(activity.name)}</h1>`, session.csrf));
  });

  app.get<{ Params: { id: string } }>("/activities/:id/edit", async (request, reply) => {
    const session = guard(request, reply);
    if (session === null) return reply;
    const activity = activityOr404(request.params.id, reply);
    if (activity === null) return reply;
    if (fake.mode === "slow_edit") await new Promise((r) => setTimeout(r, fake.slowMs));
    const hydration: Hydration =
      fake.mode === "late_hydration" ? "late" : fake.mode === "never_hydrates" ? "never" : "server";
    return reply
      .type("text/html")
      .send(
        editPage(
          activity,
          session.csrf,
          fake.mode !== "no_form",
          fake.mode !== "no_meta",
          hydration,
          fake.hydrateMs,
        ),
      );
  });

  app.post<{ Params: { id: string } }>("/activities/:id", (request, reply) => {
    const session = guard(request, reply);
    if (session === null) return reply;
    const activity = activityOr404(request.params.id, reply);
    if (activity === null) return reply;
    const entries = request.body as [string, string][];
    if (last(entries, "authenticity_token") !== session.csrf)
      return reply.code(422).type("text/html").send("<html><body>Invalid token</body></html>");
    const method = last(entries, "_method");
    if (method === "delete") {
      if (fake.mode === "delete_fails") return reply.code(500).type("text/plain").send("oops");
      if (fake.mode !== "keep_after_delete") activity.exists = false;
      if (fake.mode === "expire_after_delete") sessions.clear();
      if (fake.mode === "captcha_after_delete") fake.mode = "captcha";
      if (fake.mode === "odd_redirect_after_delete") activity.redirectWhenGone = true;
      return reply.redirect("/athlete/training");
    }
    if (method === "patch") {
      if (fake.mode !== "ignore_patch") applyPatch(activity, entries, uploaded);
      if (fake.mode === "patch_side_effect") activity.hideFromHome = !activity.hideFromHome;
      if (fake.mode === "hide_new_photos")
        activity.photos = activity.photos.filter((p) => !uploaded.has(p.uuid));
      return reply.redirect(`/activities/${activity.id}`);
    }
    return reply.code(400).send("unknown _method");
  });

  app.get("/features", (_request, reply) =>
    reply.type("text/html").send(layout("Features", "<h1>Features</h1>", null)),
  );

  app.get("/athlete/training", (request, reply) => {
    const session = guard(request, reply);
    if (session === null) return reply;
    return reply.type("text/html").send(layout("My Activities", "<h1>Activities</h1>", null));
  });

  app.get<{ Params: { id: string } }>("/activities/:id/export_original", (request, reply) => {
    const session = guard(request, reply);
    if (session === null) return reply;
    const activity = activityOr404(request.params.id, reply);
    if (activity === null) return reply;
    if (fake.mode === "export_html")
      return reply.type("text/html").send(layout(activity.name, "<p>No file</p>", null));
    return reply
      .type(activity.original.contentType)
      .header("content-disposition", `attachment; filename="${activity.original.filename}"`)
      .send(activity.original.bytes);
  });

  app.get<{ Params: { id: string } }>("/activities/:id/export_gpx", (request, reply) => {
    const session = guard(request, reply);
    if (session === null) return reply;
    const activity = activityOr404(request.params.id, reply);
    if (activity === null) return reply;
    return reply.type("application/gpx+xml").send(activity.gpx);
  });

  app.put("/photos/metadata", (request, reply) => {
    const session = guard(request, reply);
    if (session === null) return reply;
    if (request.headers["x-csrf-token"] !== session.csrf)
      return reply.code(422).send({ error: "csrf" });
    if (fake.mode === "bad_metadata") return reply.send({ nope: true });
    const { uuid } = request.body as { uuid: string };
    const signature = randomBytes(8).toString("hex");
    uploads.set(uuid, { signature, bytes: null });
    return reply.send({
      uri: `${fake.baseUrl}/upload-bucket/${uuid}?X-Synthetic-Signature=${signature}`,
      header: { "x-fake-upload-signature": signature },
    });
  });

  app.put<{ Params: { uuid: string } }>("/upload-bucket/:uuid", (request, reply) => {
    const pending = uploads.get(request.params.uuid);
    if (pending === undefined || request.headers["x-fake-upload-signature"] !== pending.signature)
      return reply.code(403).send("bad signature");
    pending.bytes = request.body as Buffer;
    uploaded.add(request.params.uuid);
    return reply.code(200).send();
  });

  // Stand-in for the full-size photo URLs the API lists (a CDN, no session).
  app.get("/media/synthetic-photo.png", (_request, reply) =>
    reply.type("image/png").send(SYNTHETIC_PNG),
  );

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  fake.baseUrl = `http://127.0.0.1:${port}`;
  fake.sessionUrl = `${fake.baseUrl}/__test/session`;
  return fake;
}
