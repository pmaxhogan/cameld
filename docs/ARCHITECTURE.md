# cameld architecture

Locked design. Deviations require a note in the commit message and a matching
update here. This document is deliberately generic: it contains no personal
data, no activity identifiers, no locations, and no credentials.

## 1. Goals

The owner records many outings on two devices at once: a wrist tracker (good
heart rate, weak GPS, noisy elevation) and a phone app (good GPS, no heart
rate). Both recordings land on Strava as separate activities. GPS accuracy
matters because downstream tools compute street coverage from it. Recording
twice is also a mutual backup.

cameld is a Node.js/TypeScript service that:

1. Polls Strava for new activities and backs up every activity indefinitely.
2. Detects pairs that are the same outing recorded by two devices.
3. Builds one merged recording that loses nothing from either source.
4. Uploads the merge, hides then deletes the originals, under strict gates.
5. Backfills the entire history.
6. Offers a web UI for review, history, backfill control and settings, plus
   Web Push notifications.

## 2. Invariants

- Never destroy information. Every sample from both sources is either in the
  merged file or preserved in the backup with a record of why it was excluded.
- Never delete or hide anything on Strava before its backup is written, read
  back, checksum-verified, and covered by a ZFS snapshot.
- When one device started earlier or stopped later than the other, the extra
  time is kept in the merge.
- Re-uploads carry the ORIGINAL date and time of the activity.
- No real data is ever committed to this repository. Test fixtures are fully
  synthetic (see CLAUDE.md).

## 3. Strava constraints that shape the design

- The public API has no delete endpoint, no GPS edit, and no original-file
  download. Streams are available but are resampled by Strava, so they are not
  a sufficient restore source.
- Uploads accept FIT, TCX and GPX (optionally gzipped). The start time comes
  from the file, and `external_id` is the dedupe key.
- Strava rejects uploads it considers duplicates of an existing activity. The
  exact rule is undocumented and is measured rather than assumed.
- Rate limits apply per 15 minutes and per day, with separate read limits. The
  client tracks both and their reset windows; a rejected request still counts.
- OAuth access tokens are short lived and refresh tokens rotate, so the newest
  refresh token is persisted on every refresh.
- Hiding, deleting, exporting original files, private notes and photo handling
  may need a strava.com web session (a headless browser) where the API cannot
  do them. This is unofficial and may break, so it is isolated behind a small
  interface and health-checked.
- When the web login asks for an emailed code, the code reaches cameld through
  a relay: a Gmail filter forwards Strava code mail to an address handled by
  Cloudflare Email Routing, a small Cloudflare Worker (`relay/`) accepts it
  only from allowlisted `From:` domains (Strava, plus Gmail forwarding
  confirmation), stores the code sealed with a 10 minute TTL, and the server
  claims the oldest code newer than its request time, once, over HTTPS with a
  bearer token. No Google credentials are held anywhere.

## 4. Merge rules

| # | Rule |
|---|---|
| L9 | Position: the phone GPS wherever it has a fix. The wrist position only where the phone has none, including before it started and after it stopped. |
| L10 | Heart rate and cadence come from the wrist device. Elevation comes from the phone. |
| L11 | Time alignment: clock first, GPS-corrected. Measure the offset that best aligns the tracks and apply it only when small and confident. A large or uncertain offset parks the pair for review. |
| L12 | Single-source stretches are used as recorded. Only points implying an impossible speed for the sport are dropped. Dropped points stay in the backup. No smoothing, nothing invented. |
| L13 | The merged file format is FIT. |
| L14 | Carry over title, description, photos and anything else portable (gear, sport type, commute and trainer flags, perceived exertion, private notes). Kudos and comments cannot move: the merge proceeds and they are archived. |
| L15 | A custom title beats a Strava default. If both are custom, the phone one wins and the other goes in the description. |
| L16 | A block appended to descriptions by a third-party coverage tool is stripped from the carried description; that tool re-adds its own. |
| L17 | Merged activities are marked in Strava private notes only. There is no public mark. |

Matching is strict. GPS pairs need different devices, the same sport type,
time windows overlapping for most of their length, and tracks within tens of
metres. Non-GPS pairs (for example indoor sessions) need the same sport type,
different devices and at least 80 percent time overlap; their merge is the
union of the time span plus the wrist heart rate. Anything weaker or borderline
goes to the review queue and is never auto-merged. Thresholds are settings.

Verification wording: the no-loss check is EXACT and runs against the locally
built merged file before upload. The post-upload check is tolerance based
(point count, distance and elapsed time within a few percent, heart rate
present, start time correct), because Strava resamples.

## 5. State machine

Every transition is recorded in SQLite and is resumable after a crash. Before
any Strava write the intent is persisted (including the `external_id`); after
it the result (upload id, activity id) is persisted. On resume the write is
looked up on Strava before being repeated, so nothing is uploaded or deleted
twice.

Implementation (`server/src/state/`): every transition updates the group
row and appends an event with its evidence. Every Strava write first commits
an intent row (with the `external_id` for uploads) and then its result. On
every tick `reconcile()` resolves open intents on Strava (an upload by its
upload id, else the activity by `external_id`; a delete by GET -> 404). An
upload rejected as a duplicate of an activity carrying the group's own
`external_id` is the group's earlier upload, never a reason for Path B. The
freeze and the owner's go-ahead are re-checked immediately before each delete.

### Rules for both paths

- **Deletion switch.** Any step that deletes requires the deletion switch to
  be ON. It is OFF by default and only the owner's explicit go-ahead turns it
  on. With it OFF, a pair that would need a delete is PARKED, never deleted.
- **Original file is mandatory for deletion.** An activity may only be deleted
  if its original uploaded file is in the backup. No original file: park.
  An activity Strava has no original for at all (`original_unavailable`, see
  section 7) parks with that reason and is never deleted.
- **Fresh backup before delete.** Immediately before any delete, take a fresh
  incremental backup of both originals (metadata, photos, kudos and comments
  may have changed), read it back, verify checksums, then snapshot.
- **Freeze on failure.** On any failed check or failed live merge, freeze all
  Strava writes, keep the evidence, keep backing up, and notify. Fix forward.
  Restore is the one exception: restore writes run first, then writes freeze.
- **Photos that cannot be re-attached** do not block a merge. They stay
  archived in the backup and the pair is flagged.
- **Captcha or verification challenge** parks the affected work and pauses all
  web-session actions until login is healthy. It does not stop API backups.

### Common prefix

1. Detect a candidate pair. Wait out the partner window (default 4 hours,
   configurable) before treating an activity as single.
2. Back up both originals in full, including the original uploaded file. Read
   back and verify checksums.
3. Score the match. Borderline goes to the review queue and stops.
4. Build the merged FIT and run the exact no-loss check. Failure freezes.
5. Take a ZFS snapshot.

### Path A (default): hide first

6. Upload the merge with a distinct `external_id`.
7. If accepted, apply carried metadata, photos and the private note.
8. Run the tolerance-based post-upload check. Failure freezes.
9. Hide both originals.
10. Wait the grace period (24 hours by default, a setting).
11. If the deletion switch is ON: re-verify the merge, take a fresh backup and
    snapshot, then delete both originals. Otherwise stop; originals stay hidden.
12. Confirm both originals are gone and the merge is intact.

### Path B: only when step 6 is rejected as a duplicate

6b. Deletion switch OFF, or an original file missing: PARK the pair and stop.
7b. Fresh backup, read-back, snapshot.
8b. Delete the wrist original only and retry the upload. If it is still
    rejected, delete the phone original and retry.
9b. If the upload still fails, re-upload the deleted originals from their
    original files, restore their metadata, then freeze and notify. If that
    restore is itself rejected as a duplicate, keep it in the backup, flag it,
    and notify.
10b. Apply metadata, photos and the private note. Run the post-upload check.

## 6. Deletion switch and rollout

Deletion is disabled by default in the deployed service. The rollout is: full
history backup, a dry-run report of every pair that would merge, a trial of
three real pairs merged, verified, aged through the grace period and deleted
(including restoring both originals of one pair from backup to prove restore
works), then a hard stop until the owner explicitly enables deletion. The trial is
a separate setting (off by default) that permits deletion for at most three
pairs while the deletion switch stays off; its tokens carry reason
`rollout_trial`. While
waiting, backfill may upload and hide only. After the go-ahead, backfill runs in
daily batches inside the rate limits.

## 7. Backups

- Every activity is backed up, paired or not: full metadata, all streams, the
  original uploaded file, photos, kudos and comments.
- Original files come from the web export, which costs a strava.com page
  request, so it is rationed. An activity Strava has no original for (the
  stored API detail says `manual: true` or `upload_id: null`, or the export
  answers 404) is marked `unavailable` with its evidence, is never exported
  again, and is backed up from metadata and streams only. It can never be
  deleted. Any other export failure keeps it `pending` and backs off
  exponentially (15 minutes doubling to a 24 hour cap, next attempt time
  persisted in SQLite); failures of the web session itself (logged out,
  challenged) are left to the web gate and do not count. All exports share
  a cap of 30 per rolling hour. The UI backfill page and
  `cameld_original_files{status}` show the counts.
- Backup files are write-once and checksummed, and are read back after
  writing.
- The data lives on its own ZFS dataset. Snapshots are taken daily and kept
  indefinitely, plus one immediately before every delete.
- The service must not receive a privileged container or the Docker socket.
  Snapshots come from a tiny host-side helper (`deploy/snapshot-helper/`).
  `POST <SNAPSHOT_HELPER_URL>/snapshot` with `authorization: Bearer
  <SNAPSHOT_HELPER_TOKEN>` and JSON `{"label": "<a-z0-9_->"}` answers 200
  `{"snapshot": "<dataset>@cameld-<label>-<UTC stamp>"}`; anything else means
  no snapshot, and nothing is deleted. The helper snapshots one dataset fixed
  on its command line and takes nothing else from the request
  (`server/src/service/snapshotter.ts`).
- Why not a TrueNAS API key (decided in Wave 6, TrueNAS SCALE 25.10): API keys
  inherit their user's privilege roles, and roles are method-level, never
  per-dataset. The narrowest role that can call `pool.snapshot.create` is
  `SNAPSHOT_WRITE`, and the middleware's own method table shows that role also
  grants `pool.snapshot.rollback`, `pool.dataset.destroy_snapshots`,
  `pool.snapshot.rename` and `pool.snapshot.update` on every dataset. A key
  that can roll back or destroy snapshots fails the backup invariant, so it
  was rejected without minting one.
- How the helper is confined: it runs as a dedicated non-root host user
  whose only ZFS right is a kernel-enforced delegation,
  `zfs allow -l -u <user> snapshot <dataset>`. Tested on the host as that
  user: snapshot of the dataset succeeds; destroy, rollback, rename, property
  changes and snapshots of any other dataset (parent included) are all
  denied. The helper also needs a bearer token (a file readable by root and
  that user only), caps itself at 120 snapshots per hour, and its code and
  token live outside the app's data mount so the container cannot change
  them. It is a transient systemd unit (`systemd-run`, `Restart=always`)
  started by a TrueNAS POSTINIT init script, because the TrueNAS root
  filesystem is replaced on upgrade. The container reaches it on the shared
  apps bridge's gateway address (the host's LAN address is not routable from
  app containers).
- Daily snapshots come from a TrueNAS periodic snapshot task on the dataset
  (`cameld-auto-%Y%m%d-%H%M`, lifetime 100 years, the longest the task form
  allows; TrueNAS has no "never expire"). Helper snapshots are manual
  snapshots and never expire. A retention task only prunes names matching its
  own schema, so neither set is touched by other tasks.
- Ownership: the dataset is owned by the app uid:gid (568:568) like the other
  custom apps. `secrets/` is 0700 and its env files 0600, also 568:568
  (amber's convention: Docker reads `env_file` as root, so this only lets the
  app read its own secrets). The browser sidecar's `custom-cont-init.d`
  scripts stay root-owned because the linuxserver image skips init scripts
  not owned by root.
- Layout under `<DATA_DIR>/backup/`: `activities/<id>/` holds content-addressed
  `metadata/`, `kudos/`, `comments/`, `web-form/` (edit-form values only,
  never tokens) and `photos/` files, plus `streams.json` and
  `original/<file>`; `merges/<group>/` holds the merged FIT, its exclusion
  ledger and the no-loss report. Every file is recorded in SQLite.

## 8. Platform

- **Stack.** Node 26 (engines >=24), npm workspaces (`shared`, `server`, `web`,
  `e2e`, `relay`), strict ESM TypeScript, Fastify, SQLite via `node:sqlite`, pino.
  Front end: Vue 3, Vite, PrimeVue, MapLibre.
- **Trigger.** Polling every 10 minutes. No webhook and no public callback.
- **Web UI.** Review queue with side-by-side and overlay map comparison of
  both tracks and the merge preview (built in memory exactly as the state
  machine would); activity and merge history with the per-group event
  timeline (plain-language labels, evidence as key/values with the raw
  JSON behind a toggle), write journal, links to the activities on Strava,
  a restore action, and the same track comparison for any group whose merge
  is built (both originals and the stored merged FIT, read from the backup);
  backfill control and status (Strava's app-wide rate usage, which other
  consumers of the Strava app share, shown apart from cameld's own backfill
  read budget and which cap stopped the last batch; login health, progress,
  the dry-run report);
  settings (grace period, partner wait, thresholds, switches for hide,
  delete, upload and the deletion trial); a "Strava login" panel that embeds
  the browser sidecar's KasmVNC client. Maps use a keyless MapLibre style
  (`MAP_STYLE_URL`, OpenFreeMap by default). Every UI write is recorded in
  the `audit_log` table with the Access identity.
- **Access.** Served through an existing Cloudflare Tunnel at a hostname such
  as `cameld.example.com`. Two gates, both required for the SPA, `/api/*`
  and `/browser/*` (only `GET /healthz` and `/metrics` are open): (1) the
  Cloudflare Access JWT, verified by the server (RS256 against the team's
  keys, cached an hour and refetched on an unknown key id at most once a
  minute; `iss`, `aud`, `exp`/`nbf` with 30 s skew, and the `email`
  claim must equal `ALLOWED_EMAIL`); (2) the secondary backup password:
  `POST /login` checks it against a PBKDF2-SHA256 hash
  (`UI_PASSWORD_HASH`, from `scripts/hash-password.ts`), rate limited per
  client and globally, and sets a 90 day HMAC session cookie (HttpOnly,
  Secure, SameSite=Strict) bound to the identity and the password hash. The
  login page needs Access but not the session. State-changing requests need
  the `X-Requested-With: cameld` header or an Origin equal to `PUBLIC_URL`;
  WebSocket upgrades need that Origin and both gates. Missing auth
  configuration fails closed. Turning deletion or the deletion trial on
  through the API also needs the typed confirmation phrase.
- **Browser sidecar view.** `/browser/` is a same-origin proxy to the
  sidecar's KasmVNC client (`BROWSER_VNC_URL`), GET and WebSocket only. The
  proxy injects the sidecar's basic-auth credentials server side, forwards an
  allowlist of headers (never the owner's cookies or the Access JWT), builds
  every upstream URL by setting the path on a copy of the base (refusing
  schemes, backslashes, dot segments and control characters) and checks the
  result stays on that origin before attaching credentials. TLS stays
  verified: the sidecar's self-signed certificate is the only trust anchor
  of the proxy's agent (`BROWSER_VNC_CA_FILE`), optionally pinned by
  SHA-256 (`BROWSER_VNC_CERT_SHA256`).
- **Notifications.** Web Push with VAPID keys (the `web-push` package),
  subscriptions in SQLite, a service worker in the SPA. Every owner
  notification is logged and pushed: writes frozen, failed merge, login
  expired, parked pair, pair needs review, backfill batch done, deletion
  trial done, restore flagged. Subscriptions the push service reports gone
  (404/410) are deleted.
- **Deploy.** A TrueNAS custom app that auto-pulls the latest image from GHCR,
  running as an unprivileged uid with no published ports (see
  `deploy/compose.example.yml`).
- **Observability.** Prometheus metrics, Grafana dashboard and alert rules,
  structured NDJSON logs shipped to Loki, and `GET /healthz` returning
  `{ok, version}`. Metrics: merges, parked pairs, frozen state, rate-limit
  usage, backup size and count, original files by status and export outcomes,
  last successful poll, web-session login health.
  Alerts: failed merge, frozen writes, login expired, polling stalled, backup
  write failure.
- **Configuration.** `loadConfig(process.env)` is the only environment reader.
  Variables are listed in `.env.example`; real values live only on the host.

## 9. Testing

Unit and integration tests run against a fake Strava server covering both the
API and the web pages. Property-based tests assert that no sample is lost in a
merge. Playwright covers the UI. A coverage ratchet (tolerance 0.5 points)
guards regressions. All fixtures are synthetic, generated by an agent with no
access to real data and reviewed by a second agent.

## 10. CI/CD

- CI: lint, typecheck, ASCII dash check, tests with coverage ratchet, a Node 24
  compatibility run, build, Playwright smoke, and `npm audit` at the high
  level.
- The image build is gated: it runs only after CI succeeds on `main`, builds a
  multi-stage image with Playwright Chromium and its OS dependencies, smoke
  tests that exact image, then pushes `latest` and `sha-<short>` to GHCR.
- Dependabot updates npm, Docker and GitHub Actions weekly. Minor and patch
  updates are approved and auto-merged once checks pass; majors are reviewed.
