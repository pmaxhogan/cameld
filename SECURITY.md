# Security policy

## Supported versions

cameld is pre-1.0. Only `main` and the `:latest` container image are
supported. There are no backports.

## Reporting a vulnerability

Please report privately through GitHub: open the repository's **Security** tab
and choose "Report a vulnerability" (a private advisory). Include what you
found, how to reproduce it, and the impact you expect. This is a single
maintainer project: expect a best-effort acknowledgement within about a week.
There is no bounty.

Never put credentials, tokens, or personal data in an issue or pull request.

## Security model

- **Authentication.** The service sits behind a Cloudflare Tunnel and a
  Cloudflare Access application. The server itself verifies the Access JWT
  (signature against the team's keys, issuer, audience, expiry, and an email
  allow list) and fails closed. A secondary backup password (PBKDF2 hash only,
  signed session cookie) protects the UI if Access is misconfigured. `/healthz`
  is the only unauthenticated route and returns nothing sensitive. Auth lands
  in a later milestone; until then, do not expose an instance publicly.
- **Secrets.** Strava client secret, the web-session login, the session
  secret, and VAPID keys live only in an env file on the host, never in git,
  argv, URLs, logs, API responses, or error messages. Logs redact
  authorization headers, cookies, and password/token/secret fields.
- **Data safety.** Backups are write-once and checksummed. Nothing is hidden or
  deleted on Strava before a verified backup and a filesystem snapshot exist,
  and deletion is off unless the owner explicitly enables it.
- **Container.** Runs as an unprivileged uid, with no published port, no
  privileged mode, and no Docker socket. Snapshots are requested through a
  narrowly scoped helper, not by giving the container host access.
- **Supply chain.** CI runs `npm audit` at the high level, Dependabot updates
  npm, Docker, and GitHub Actions weekly, and the image is built only after CI
  succeeds on `main`.

## Out of scope

Findings that require the host or the owner's Cloudflare account to already be
compromised, vulnerabilities in the base image or upstream dependencies with no
reachable path here, and scanner output with no demonstrated impact.
