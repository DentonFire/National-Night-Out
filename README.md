# national-night-out

National Night Out map for Denton Fire Department crews: every party on one map, with the units,
PD and the Mayor attending. Command (Battalion Chiefs, Assistant Chief) drags units from a station
roster onto parties; crews sign in and see who's going where.

See [`PROJECT.md`](PROJECT.md) for accounts and data handling.

## Run locally

```bash
python3 -m http.server 5173
```

- http://localhost:5173/?demo=1 runs in the browser only, with synthetic parties.
  `&role=crew` shows the crew view. `&live=18:15` previews "Live now" at that time.
  `&tour=1` replays the first-run walkthrough (also the ? button in the header).
- http://localhost:5173/ uses the real backend once `js/config.js` has the Firebase config.

## Files

| Path | What |
|---|---|
| `index.html`, `css/app.css` | Page and styles (house style shared with Water-Shutoff) |
| `js/app.js` | Map, roster, drag-and-drop, tap-to-assign, detail panel, dialogs |
| `js/store.js` | Firebase and demo backends behind one interface |
| `js/importer.js` | Reads the NNO spreadsheet in the browser; skips host names |
| `js/roster.js` | Stations and assignable units |
| `js/icons.js` | Vehicle and Mayor icons (authored SVG) |
| `js/tour.js` | First-run walkthrough (separate Command and Crew steps) |
| `data/fire-districts.geojson` | City of Denton 2024 fire districts (public GIS layer) |
| `firestore.rules` | Who can read and write |

## Deploy rules

```bash
firebase deploy --only firestore:rules --project <project-id>
```
