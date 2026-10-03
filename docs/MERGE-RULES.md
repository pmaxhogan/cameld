# Matching and merge rules (tuned)

These numbers were tuned on the owner's real recordings. Only the resulting
rules are recorded here; no real data is. Every number below is a setting
with this default. Implementers: this file plus `ARCHITECTURE.md` section 4
is the whole specification. Do not look for the underlying data.

## Source fingerprint

- Fitbit copy: `device_name` starts with `Fitbit` (seen: `Fitbit`,
  `Fitbit Versa 4`). When `device_name` is absent, `external_id` matching
  `^(fitbit_)?\d{11,19}\.tcx$` or starting with `stripped_health_data_` (gpx).
- Strava app copy: `device_name` is `Strava App`, or `external_id` ends in
  `-activity.fit`. Older app uploads may have a null `external_id`.
- Anything else is "other" (bike computers etc.). A pair needs two different
  sources; other-vs-Fitbit pairs are allowed and go through the same rules.

## Original files are the merge input

- API streams are NOT a faithful copy: they forward-fill missing heart rate,
  fill missing positions, nudge some positions, and replace altitude. Merges
  and the exact no-loss check use the ORIGINAL uploaded files only (Fitbit:
  TCX, or GPX for old ones; Strava app: FIT). Streams are for display and
  matching only.
- The Strava app FIT can contain two records with the same timestamp
  (sub-second recording). Merge records that share a timestamp; keep every
  field value (later non-null wins per field; conflicts go to the ledger).

## Pairing

- Pairing is 1-to-N: one app recording can pair with several Fitbit
  recordings when the Fitbit split one outing into parts (and vice versa).
  Model a pair as a group with one primary per source.
- Time overlap is measured against the SHORTER activity (or the shorter
  side of a group). Auto-match needs overlap >= 0.80.
- Start delta up to 600 s; beyond that only when overlap >= 0.80.
- GPS proximity: median distance between time-aligned points, after the
  clock offset is applied. <= 25 m auto-merge; 25-100 m review queue;
  > 100 m no match. The p90 is shown in the UI but is not a criterion.
  Distance ratio between the copies is NOT a criterion (a noisy Fitbit
  track can be 1.4x longer from jitter alone).
- Non-GPS pairs: same sport type, different sources, overlap >= 0.80.
  Anything weaker goes to review.
- Same sport type required for auto-match; a mismatch goes to review.

## Partner arrival

- A copy can arrive many hours, even days, after its partner. The partner
  wait (default 4 h) only decides when a recording is reported as "single".
  "Single" is NOT terminal: a later arrival that matches re-opens pairing
  for that recording, as long as it has not been merged already.

## Clock alignment (L11)

- The Fitbit clock runs a few seconds behind the app (typically 3-8 s,
  always in the same direction). Align by searching offsets in +/- 120 s at
  1 s steps, minimising the median distance between time-aligned points.
- Apply automatically when: the cost at +/- 10 s from the best is at least
  5x the best cost (sharp), the median residual is <= 2 m, and the offset is
  <= 15 s. Offset > 15 s with a sharp minimum parks the pair for review.
- A flat cost curve (the Fitbit track is independent and noisy) means
  offset 0 is used and the pair is NOT parked for that reason.
- Non-GPS pairs use offset 0.

## Impossible-speed filter (L12)

- Applies only to positions taken from the Fitbit (stretches where the app
  has no fix). Compare each point with the last KEPT point, allowing 10 m of
  slack: speed = max(0, distance - 10 m) / dt.
- Limits: walk / hike 7 m/s, run 12 m/s, ride 25 m/s (setting per sport).
- If 30 consecutive points would be dropped, accept the new location as
  real (re-anchor) instead of dropping indefinitely.
- Every dropped point goes into the exclusion ledger with its reason.

## Field sources (L9, L10)

- Position: app wherever it has a fix; Fitbit elsewhere, including before
  the app started and after it stopped.
- Heart rate and cadence: Fitbit. Elevation: app.
- Strava keeps file altitude from some devices and replaces it with its own
  terrain model for others (it replaced the app's). Whatever ends up on
  Strava, the merged FIT carries the app's elevation and the backup keeps
  both.

## Implementation choices where the rules are silent

Recorded so the code and this file agree (shared/src/match, shared/src/merge).

- Sharp clock minimum, offset <= 15 s, residual > 2 m and a non-zero best
  offset: parked for review as "uncertain" (L11), offset 0 not applied.
- Distance and speed follow the app, like elevation: cumulative distance from
  two devices cannot be mixed. A field the preferred side never carries is
  taken from the other side (for example altitude from the Fitbit when the
  other device records none). Unused values go to the exclusion ledger.
- The speed filter accepts the 30th consecutive would-be drop as the new
  anchor (29 are dropped). An app fix in between restarts the count. Sports
  outside walk, hike, run and ride are not filtered by default.
- Groups with three sources, splits on both sides, or overlapping parts on
  one side go to review. A pair where only one side has GPS is judged by the
  non-GPS rule.
