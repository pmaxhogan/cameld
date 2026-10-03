# Synthetic test fixtures

Everything in this directory is **synthetic**. No file here was copied from,
derived from, or checked against a real recording, a real person, or a real
place a person frequents. The data is generated in code on every test run.

- `synthetic-track.ts` builds a 1 Hz outing on a small ellipse centred on
  **lat 0.5, lng 0.5**, a point in open ocean in the Gulf of Guinea chosen
  because nobody lives or trains there. Channels are sine waves plus noise from
  a seeded PRNG (mulberry32), so output is identical on every run. The start
  time is an arbitrary fixed instant (2020-02-02T02:02:02Z).
- `xml.ts` serializes generated samples as GPX 1.1 and TCX v2 text for the
  reader tests.
- `pair-generator.ts` simulates one fictional outing recorded twice (an
  "app" copy and a "fitbit" copy) on a 400 m circle around the same lat 0.5,
  lng 0.5 origin. Formulas plus seeded noise; the knobs are clock lag, early
  and late starts, app GPS gaps, sub-second duplicate records, missing Fitbit
  fixes, Fitbit noise and position spikes. `syntheticPairOptionsArb` draws
  those knobs at random for the merge property tests.
- `arbitraries.ts` holds fast-check arbitraries that draw samples from the
  full range the FIT writer accepts (any latitude and longitude, extreme
  altitudes and speeds), which is deliberately unlike any real outing.

Rules (from CLAUDE.md): fixtures are written by an agent that has seen no real
data, reviewed by a second agent before commit, and never contain real
activities, activity IDs, coordinates, place names, email addresses, tokens or
credentials. Do not add recorded files here; add a generator instead.
