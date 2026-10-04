# national-night-out

> **Required file.** Every project has one. A project without a filled-in `## Accounts` block
> is a policy violation — see `~/Dev/AGENTS.md` Section 5.

- **Scope:** `denton-fire`
- **Created:** 2026-10-04
- **Status:** draft <!-- draft | pending-clone | active | maintenance | archived -->
- **Owner:** Hunter Lott

## What this is

A National Night Out map for Denton Fire Department crews. Every NNO party shows on a Leaflet map
with its address, time, who's attending, council district and fire district. Battalion Chiefs and
the Assistant Chief (Command) drag units from a station roster onto parties. Crews sign in with a
verified `@cityofdenton.com` email and see where every unit, PD and the Mayor will be. Built in the
house style of the other `dentonfire.github.io` tools (Water-Shutoff is the closest sibling).

## Accounts ★

| Service | Scope | Account / org / team | Identifier | Notes |
|---|---|---|---|---|
| GitHub | `denton-fire` | user `DentonFire` | `TODO` (repo URL, planned `DentonFire/National-Night-Out`) | Public GitHub Pages site. No PII, no party data in the repo |
| Vercel | — | none | — | Hosted on GitHub Pages |
| Supabase | — | none | — | Backend is Firebase |
| Firebase | `simpli-fi` (**OS**) | `hunter.lott@simpli-fi-os.com` | `dfd-national-night-out` (number 556210811085; web app `1:556210811085:web:0a5869373b0bb40995f984`) | Dedicated project, on Hunter's instruction (ADR 0009). Auth (email/password) + Firestore |
| Other | public | City of Denton ArcGIS | `2024_Fire_Districts_WFL1` | Fire district polygons, bundled in `data/fire-districts.geojson` |

## Data handling

- Party data comes from the Community Engagement spreadsheet. Command imports it in the app
  (Import button). The browser parses it and **drops the Party Host Name column before anything
  is written**. Host names never reach Firestore or the repo.
- The spreadsheet itself stays out of this repo (`.gitignore` blocks `*.xlsx` and `*.csv`).
- Firestore rules allow reads only to verified `@cityofdenton.com` users; writes only to users
  listed in `roles/{email}` with role `command`.

## Running locally

```bash
python3 -m http.server 5173   # from this folder, then open http://localhost:5173/
```

`?demo=1` runs entirely in the browser with synthetic parties and no backend.

## Notes for agents

Project-specific rules go in `AGENTS.md` next to this file. Workspace rules are in
`~/Dev/AGENTS.md` and always apply.
