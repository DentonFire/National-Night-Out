# AGENTS.md — national-night-out

The workspace policy at **`~/Dev/AGENTS.md`** applies to this project and takes precedence.
This file only adds project-specific rules; it never relaxes the workspace ones.

**Before touching any remote, read `PROJECT.md` in this directory for the account mapping,
and confirm it against `~/Dev/docs/ACCOUNTS.md`.** State the account you are using before
you use it.

## Project-specific rules

- No real party data, spreadsheets or host names in the repo. It is a public GitHub Pages site.
  Tests and demos use the synthetic parties in `js/store.js`.
- Keep the house style of the other `dentonfire.github.io` tools (Water-Shutoff is the reference).
- Firestore rules are the security boundary, not the page. Change them with the page, never after.
- Run `./bump-version.sh` before every push. GitHub Pages caches files for 10 minutes, and the
  version stamps in `index.html` make browsers load a matching set of scripts.

## Commands

```bash
python3 -m http.server 5173                       # then open http://localhost:5173/?demo=1
./bump-version.sh                                 # before every push
firebase deploy --only firestore:rules --project <project-id>
```
