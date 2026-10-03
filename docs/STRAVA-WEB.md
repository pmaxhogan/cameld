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
- `activity[hide_from_home]` (mute)
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
