# Strava web session (observed behaviour)

The API cannot delete, set visibility, write private notes, set perceived
exertion, export original files, or attach photos. These go through the
strava.com web session in the `cameld-browser` sidecar: a real headed Chrome
with a persistent profile, driven over CDP (`connectOverCDP`, use
`browser.contexts()[0]`). Always work in a NEW page and close only that page.
Never close the browser, never touch other tabs, never log out.

## Login

- Login is email plus an emailed 6-digit code (no password). An invisible
  reCAPTCHA Enterprise guards `POST /login/request_otp`; scripted requests
  get 403. The owner logs in by hand once through the sidecar's web VNC.
- Keep the session alive by loading `/dashboard` about hourly in a new page.
  Logged in = not redirected to `/login` and the athlete menu is present.
- On expiry: try one automatic login (code via the relay,
  `server/src/relay/client.ts`). If `request_otp` is refused, report the
  login as unhealthy, pause all web actions, and push-notify the owner to
  log in through the embedded VNC. Never retry blindly.

## Requests (all from a page already on www.strava.com, credentials included)

Fetches from `about:blank` fail CORS; navigate to a strava.com page first.

| Action | Request |
|---|---|
| Original file | `GET /activities/<id>/export_original` -> 200 `application/octet-stream`, filename in `Content-Disposition` (FIT, TCX or GPX, whatever was uploaded) |
| GPX export | `GET /activities/<id>/export_gpx` |
| Edit form | `GET /activities/<id>/edit`; CSRF token in `meta[name=csrf-token]` and the form's `authenticity_token` |
| Save edits | `POST /activities/<id>` form-encoded, `_method=patch`, `authenticity_token`, fields below |
| Delete | `POST /activities/<id>` form-encoded, `_method=delete`, `authenticity_token` |

Edit form fields:

- `activity[private_note]` text
- `activity[visibility]` one of `everyone`, `followers_only`, `only_me`
  ("Only You" = hidden)
- `activity[perceived_exertion]` plus `activity[prefer_perceived_exertion]`
- `activity[hide_from_home]` (mute); the live site sends `true` when on.
  cameld reads `true`, `1` and `on` (any case) as on.
- name, description, sport type, gear, stats visibility, tags are also on
  the form; prefer the API for fields it supports.

Delete notes:

- The UI link is jquery-ujs `a[data-method=delete][href=/activities/<id>]`
  with a native confirm. The Log Out link ALSO uses `data-method=delete`:
  never select a delete control by that attribute alone. cameld sends the
  request itself with the exact activity URL and never clicks links.
- Strava's confirm text says a deleted activity can be restored for 30
  days. Treat that as an extra safety net, not as the restore mechanism;
  restore is re-upload from the backed-up original file.

## Photos

- Download: full-size image URLs from the API photos list
  (`/activities/<id>/photos?size=5000`), plain GET.
- Upload (from the edit page JS): `PUT /photos/metadata` with
  `{athlete_id, uuid, taken_at, media_type, location}` returns
  `{uri, header}`; `PUT <uri>` with the file and the returned headers;
  then saving the edit form with `photos[<uuid>][rank|media_type|caption]`
  attaches it. Captions: `PUT /media/<type>/<id>/add_caption`.
- Unverified until the first real upload: the presigned upload host, and
  photo removal.

## Implementation (server/src/web/)

`WebSession` (`session.ts`) implements the `StravaWebSession` interface over
`connectOverCDP(BROWSER_CDP_URL)`. Every operation opens a new page in
`contexts()[0]`, closes only that page (bounded, even on timeout), and runs
strictly one at a time. `disconnect()` drops the CDP connection only; on a
CDP-connected browser `Browser.close()` leaves the process, its tabs and its
cookies alive (an integration test checks this).

- Requests are in-page `fetch` calls with credentials (`in-page.ts`, the only
  code that runs in the browser) to URLs built from a validated numeric id.
- The edit form is hydrated by Strava's React code AFTER the HTML loads: the
  `activity[visibility]` radios were missing in 7 of 10 live reads taken at
  load and present in 4 of 4 taken 6 s later. A form read (or POSTed) too
  early would reset the visibility. So every form read first waits
  (`page.waitForFunction`, polling every 100 ms, bounded by
  `formHydrationTimeoutMs`, default 15000) until the form has a non-empty
  `authenticity_token`, a CHECKED `activity[visibility]` radio and the
  `activity[private_note]` field. If it is not hydrated in time it throws
  `WebNotReadyError` (`not_ready`) and sends nothing; a page with no activity
  form at all is still `WebUnexpectedResponseError`. Independently, every
  POST of the form (edit, delete, photo attach) refuses with
  `WebNotReadyError` if the body it is about to send lacks any of those
  required fields (`assertSubmittable`).
- Edits read the whole form as `FormData` entries, change only the target
  field(s), POST everything back with `_method=patch` and the form's
  `authenticity_token` (plus `X-CSRF-Token`), then re-read the form and throw
  `WebVerificationError` if a changed field did not stick or any other field
  moved.
- Expiry (redirect to `/login`, 401) throws `LoginRequiredError`; captcha or
  verification pages, 403 and 429 throw `ChallengeError` (`kind`). Nothing is
  retried. `login()` tries once; after a failure it refuses until a health
  check sees a live session again.

### DeletionAuthorization

`deleteActivity(id, auth)` requires a `DeletionAuthorization`
(`deletion-authorization.ts`). Only the merge state machine
(`server/src/state/`) may mint one, via `DeletionAuthorization.mint(evidence)`:

- the constructor is private, and ESLint (`no-restricted-syntax`) rejects the
  `mint` call anywhere except `server/src/state/**` and tests;
- the evidence demands `deletionSwitch: "on"` (or `"trial"`, accepted only
  with reason `rollout_trial`: the owner's separately switched allowance of
  at most three trial pairs), `originalFileBackedUp: true`,
  a ZFS snapshot name and a backup verified within the last 15 minutes, all
  re-checked at runtime;
- the token is branded with an ECMAScript private field (look-alike objects
  and casts are refused), names exactly one activity, expires after 15
  minutes, and is spent before the delete request is sent, even if that
  request then fails.

The delete is `POST /activities/<id>` with `_method=delete`, then
`GET /activities/<id>` must answer 404 or redirect (still logged in) to a
known post-delete page (`/athlete/training`, `/dashboard`); anything else is
`DeletionNotConfirmedError`. If that check is sent to `/login` or
challenged, the delete was sent but its outcome is UNKNOWN:
`LoginRequiredError` / `ChallengeError` with "sent but unconfirmed", never
success. The state machine must ALSO confirm deletion through the API
(`GET /api/v3/activities/{id}` -> 404) before recording an activity as gone.

### Unverified until the first live session

- The athlete-menu selector used for "logged in" (`athleteMenuSelector`).
- The login page selectors and submitting each step with Enter.
- Photo upload: the `/photos/metadata` body (`media_type: 1`,
  `location: null`), the presigned upload host and headers, and whether the
  edit form lists the new photo afterwards (reported as `verified`).

### Tests

`server/test/fake-strava/` is a synthetic, Rails-like fake of these pages. It
resets any field missing from a PATCH, carries a `data-method=delete` Log Out
link on every page, and has modes for expiry, captcha, 403, 429, refused
`request_otp`, slow pages and failed saves. Its visibility control is radios,
like Strava's; `late_hydration` injects them by script `hydrateMs` (1500)
after load and `never_hydrates` never does. The integration tests spawn a real
Chromium with `--remote-debugging-port` and connect over CDP, like the
sidecar. CI installs it with `npx playwright install --with-deps chromium`.
