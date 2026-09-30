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

### Rules for both paths

- **Deletion switch.** Any step that deletes requires the deletion switch to
  be ON. It is OFF by default and only the owner's explicit go-ahead turns it
  on. With it OFF, a pair that would need a delete is PARKED, never deleted.
- **Original file is mandatory for deletion.** An activity may only be deleted
  if its original uploaded file is in the backup. No original file: park.
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
works), then a hard stop until the owner explicitly enables deletion. While
waiting, backfill may upload and hide only. After the go-ahead, backfill runs in
daily batches inside the rate limits.

## 7. Backups

- Every activity is backed up, paired or not: full metadata, all streams, the
  original uploaded file, photos, kudos and comments.
- Backup files are write-once and checksummed, and are read back after
  writing.
- The data lives on its own ZFS dataset. Snapshots are taken daily and kept
  indefinitely, plus one immediately before every delete.
- The service must not receive a privileged container or the Docker socket.
  Snapshots are requested through a narrowly scoped TrueNAS API key (snapshot
  create on that dataset only) if the platform supports that scope, otherwise
  through a tiny host-side helper that snapshots on request
  (`SNAPSHOT_HELPER_URL`). The choice is documented when implemented.

## 8. Platform

- **Stack.** Node 26 (engines >=24), npm workspaces (`shared`, `server`, `web`,
  `e2e`), strict ESM TypeScript, Fastify, SQLite via `node:sqlite`, pino.
  Front end: Vue 3, Vite, PrimeVue, MapLibre.
- **Trigger.** Polling every 10 minutes. No webhook and no public callback.
- **Web UI.** Review queue with map comparison; activity and merge history with
  restore; backfill control and status (rate budget, login health); settings
  (grace period, thresholds, switches for hide, delete and upload).
- **Access.** Served through an existing Cloudflare Tunnel at a hostname such
  as `cameld.example.com`, behind Cloudflare Access verified by the server,
  plus a secondary backup password.
- **Notifications.** Web Push with VAPID keys.
- **Deploy.** A TrueNAS custom app that auto-pulls the latest image from GHCR,
  running as an unprivileged uid with no published ports (see
  `deploy/compose.example.yml`).
- **Observability.** Prometheus metrics, Grafana dashboard and alert rules,
  structured NDJSON logs shipped to Loki, and `GET /healthz` returning
  `{ok, version}`. Metrics: merges, parked pairs, frozen state, rate-limit
  usage, backup size and count, last successful poll, web-session login health.
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
