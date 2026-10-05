# Pre-launch audit brief: DFD National Night Out map

**For:** Codex and Grok. **Written by:** Claude Code, 2026-10-05. **Owner:** Hunter Lott.
**Deadline:** findings within 2 hours. People start creating accounts **today**; the event is
**Tuesday 2026-10-06, 5:00–8:30 p.m.** Prefer the smallest safe fix. Nothing ships without review.

Live site: https://dentonfire.github.io/National-Night-Out/ (GitHub Pages, `main`, repo
`DentonFire/National-Night-Out`). Backend: Firebase project `dfd-national-night-out` (Auth
email/password + Firestore). Local copy: `~/Dev/projects/denton-fire/national-night-out`.

---

## 1. Hard rules (read first)

Workspace policy `~/Dev/AGENTS.md` applies in full. In addition, for this audit:

1. **Never touch production.** Do not create, sign in to, or reset accounts on the live site. Do not
   write to the `dfd-national-night-out` Firestore or Auth, deploy rules, change Firebase settings,
   push to `main`, or change GitHub Pages. Read-only unauthenticated probes of the live site
   (HTTP status, headers, served files) are fine.
2. **No real data.** Do not open spreadsheets in `~/Downloads` or anywhere else. Do not open
   `~/Dev/Ops/` (ADR 0007). Use demo mode (`?demo=1`, synthetic parties) or the emulators.
3. **No email to real people.** Only the Auth emulator may "send" verification or reset emails.
4. **Work in your own worktree** (`~/Dev/AGENTS.md` and `docs/TEAMWORK.md`):
   `git worktree add .worktrees/<agent>-audit -b <agent>/audit-2026-10-05`. Commit there. Do not
   push, do not merge. Claude integrates after Hunter approves. Git identity is automatic
   (DentonFire noreply); do not override it.
5. **Stay in your lane** (section 5) so you never edit the same files at the same time. If a fix
   belongs to the other lane, write it up instead of making it.
6. The repo is **public**. No names, emails, phone numbers or party data in code, tests, fixtures,
   commit messages or your report. Use obviously fake test identities
   (e.g. `audit.tester@cityofdenton.com`) in the emulator only.

## 2. How to run it safely

```bash
cd ~/Dev/projects/denton-fire/national-night-out
python3 -m http.server 5173                       # serves the static site
```

- **Demo mode** (no backend): http://localhost:5173/?demo=1 (`&role=crew` for crew view,
  `&tour=1` to replay the walkthrough, `&live=18:15` to simulate "Live now").
- **Emulator mode** (real auth flows, nothing leaves the machine): in a second terminal run
  `firebase emulators:start --only auth --project demo-nno`, then open
  http://localhost:5173/?emulator=1. The emulator prints verification and reset links in its log,
  and `GET http://127.0.0.1:9099/emulator/v1/projects/demo-nno/oobCodes` returns them.
  Emulator mode only activates on `localhost`/`127.0.0.1` (`js/store.js`).
- **Firestore emulator / rules tests** need Java, which is **not installed** on this Mac. Ask Hunter
  before installing a JDK (see `~/Dev/docs/STACK.md`). Without Java, test rules by reading them and
  write the tests so Claude can run them later.

Claude verified on 2026-10-05 in emulator mode: sign-up → "verify your email" box → verification →
page continues on its own; forgot password with a messy address (spaces, capitals) → reset → old
password rejected → new password works. Re-test these, then go deeper.

## 3. What exists

| File | Role |
|---|---|
| `index.html`, `css/app.css` | Page, dialogs, styles (Tailwind CDN + custom CSS) |
| `js/app.js` | Auth UI, map, roster, drag-and-drop, detail card, My Unit, coverage, finalize/lock, notify email, overflow menu |
| `js/store.js` | Firebase and demo backends; emulator switch |
| `js/importer.js` | Spreadsheet import (SheetJS from cdnjs); drops the host-name column |
| `js/tour.js` | First-run walkthrough |
| `js/config.js` | Public Firebase web config; event date computed (first Tuesday in October) |
| `firestore.rules` | Reads: verified `@cityofdenton.com`. Writes: `roles/{email}` = command/owner. `config/event.finalized` locks party writes |
| `bump-version.sh` | Cache-busting stamps in `index.html`; run before every push |

Roles: **owner** (Hunter) and **command** (7 chiefs) are documents in `roles/`. Everyone else with
a verified city email is **crew** (read-only).

## 4. Known issues and suspicions to verify

Confirm or refute each, with evidence:

1. **"Live · synced" can lie.** `subscribeParties` success sets the status even when the snapshot
   comes from cache or the backend is unreachable (seen in emulator mode without Firestore). Use
   `snapshot.metadata.fromCache` / `hasPendingWrites`.
2. **No offline cache.** Crews in dead spots lose the map on reload. Consider Firestore
   `persistentLocalCache` so the last-known assignments survive a refresh.
3. **Move is two writes** (`assignUnit` then `unassignUnit` in `wireDrag`). A failure between them
   leaves a unit at both parties. Should be one batched write.
4. **Third-party scripts without Subresource Integrity:** Tailwind CDN, unpkg Leaflet, cdnjs
   QRCode and SheetJS, gstatic Firebase. No Content-Security-Policy (GitHub Pages cannot send
   headers; a `<meta http-equiv="Content-Security-Policy">` is possible). Assess risk vs. breakage.
5. **Browser API key unrestricted.** The Firebase web key is public by design, but should be
   restricted to HTTP referrers `dentonfire.github.io/*` and `localhost` in Google Cloud. Hunter must
   do this; write the steps.
6. **Unknown live Auth settings** (Claude's Firebase CLI session expired): email enumeration
   protection, password policy (default min 6), and whether client sign-up should stay open. Write
   what to check and the recommended values. Do not change them.
7. **XSS.** Spreadsheet fields (name, address, notes, "Other") and role emails are rendered with
   `innerHTML` after `esc()`. Audit every `innerHTML`/template literal, attributes included
   (`title`, `data-*`, `href`). Directions links use numeric lat/lng only: confirm.
8. **Firestore rules gaps.** Is any read or write possible for: an unverified account, a verified
   non-city account, a city account with no role, a command user editing `roles/`, a command user
   writing while finalized, a client writing a party with extra fields (e.g. a host name)? The
   finalize lock applies to parties but `config/event` is writable by any command user: intended,
   confirm nothing else leaks.
9. **Session and sign-out.** Persistence is local with no expiry. Is that right for shared station
   tablets? Does sign-out fully clear state (listeners, My Unit choice, tour flag)?
10. **mailto length.** The department email is about 1,860 characters URL-encoded. Check Outlook on
    Mac/iOS/Windows limits; Copy is the fallback.

## 5. Lanes

### Codex: auth, security, data integrity (`js/store.js`, `firestore.rules`, auth parts of `js/app.js`)

- Every auth path in emulator mode, including errors: wrong password, unknown email, weak
  password, already-registered email, non-city domain, unverified sign-in, resend verification,
  too-many-requests, offline, verify link opened in another browser, reset link reused.
- Rules review against section 4.8. Write emulator rules tests (`@firebase/rules-unit-testing`)
  under `tests/rules/` even if Java blocks running them today.
- Items 1, 3, 4, 5, 6, 7, 9 from section 4.
- Confirm no secret or PII is in the repo or its git history.

### Grok: UX/UI, mobile, accessibility, copy (`index.html`, `css/app.css`, `js/tour.js`, non-auth UI in `js/app.js`)

- Demo mode at 390×844, 844×390, 768×1024, 1440×900, plus a real iPhone (Safari) and Android
  (Chrome) if available. Crew and Command. Walkthrough on each.
- Drag-and-drop with mouse and touch, tap-to-assign, move, unassign, finalize/check/lock/unlock,
  notify dialog (Copy, Open in email), import dialog, My Unit, coverage, legend, QR.
- Keyboard-only and screen reader pass (VoiceOver): focus order, labels, dialogs, the tour.
- Contrast, tap-target size (44px), text that wraps or clips, sticky elements covering controls.
- Every user-facing string: clear, consistent, firefighter-friendly. Flag anything confusing.
- Item 2 from section 4, and load time on a throttled 4G profile.
- Run `~/Dev/infra/agent-skills/impeccable/scripts/impeccable detect --json index.html css/app.css js/app.js js/tour.js`
  from the project root and triage its findings (several earlier ones were false positives from
  the Tailwind CDN).

## 6. Deliverable

Write `docs/reviews/2026-10-05-<agent>-audit.md` in your worktree:

| # | Severity | Area | Finding | Evidence / repro | Fix (branch commit or proposal) |
|---|---|---|---|---|---|

Severity: **P0** blocks launch (people can't sign in, data exposed, wrong assignments shown) ·
**P1** fix before 5 p.m. Tuesday · **P2** after the event. Lead with a 3-line verdict: ready / ready
with fixes / not ready. List exactly what you tested and what you could not test, and why.
Fix P0/P1 items on your branch, one commit per fix, each with a one-line test note.
