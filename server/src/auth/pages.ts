/**
 * The two server-rendered pages of the auth flow. They are static apart from
 * a fixed message, so nothing user-supplied is ever interpolated.
 */

export type LoginMessage = "wrong_password" | "rate_limited" | "unconfigured" | null;

const MESSAGES: Record<Exclude<LoginMessage, null>, string> = {
  wrong_password: "Wrong password.",
  rate_limited: "Too many attempts. Wait a few minutes and try again.",
  unconfigured: "Password login is not configured on the server.",
};

export function loginPage(message: LoginMessage = null): string {
  const text = message === null ? "" : `<p class="err" role="alert">${MESSAGES[message]}</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cameld - sign in</title>
<style>
  :root { --bg:#f8fafc; --text:#0f172a; --accent:#0f766e; --input:#e2e8f0; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0b1120; --text:#e2e8f0; --accent:#14b8a6; --input:#1e293b; }
  }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    background:var(--bg); color:var(--text); }
  form { display:flex; flex-direction:column; gap:12px; width:min(320px,85vw); }
  h1 { font-size:1.4rem; margin:0 0 4px; }
  label { font-size:0.9rem; }
  input { font-size:1rem; padding:12px; border-radius:10px; border:none;
    background:var(--input); color:var(--text); }
  button { font-size:1rem; padding:12px; border-radius:10px; border:none;
    background:var(--accent); color:#fff; font-weight:600; cursor:pointer; }
  .err { color:#dc2626; font-size:0.9rem; margin:0; }
</style></head><body>
<form method="post" action="/login">
  <h1>cameld</h1>
  ${text}
  <label for="password">Backup password</label>
  <input id="password" type="password" name="password" autofocus autocomplete="current-password" required>
  <button type="submit">Sign in</button>
</form>
</body></html>`;
}

/**
 * Served instead of the login page when a navigation arrives cross-site
 * (typically the redirect back from Cloudflare Access): a SameSite=Strict
 * cookie is withheld on that first request, so reload once same-origin.
 */
export function reloadPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="0">
<title>cameld</title></head><body></body></html>`;
}
