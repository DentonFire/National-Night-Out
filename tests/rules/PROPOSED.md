# Proposed rules (not deployed)

`firestore.rules.proposed` is Codex's stricter rule set from the 2026-10-05 audit (field allowlists,
value checks, owner self-demotion guard). It is **not** live: production still runs `../../firestore.rules`.

Promote it only after `rules.test.mjs` passes against it in the Firestore emulator (needs Java),
including a full 21-party import transaction, assign, move, Mayor, Move pin, Finalize/Unlock and
Access writes made the way the app makes them. Then copy it over `firestore.rules` and deploy.
