ready with fixes

The phone blockers in this lane are fixed on `grok/audit-2026-10-05` and retested. The live site is still the 14:41 build and does not include them.

Two sign-in failures and the offline cache remain in the Codex lane. This branch was not pushed or merged.

People can create accounts today. The event is Tuesday 2026-10-06, 5:00–8:30 p.m. This pass used demo mode and a local Auth emulator on project `demo-nno` only. It did not touch the production Firebase project, GitHub Pages, or `main`. The shared board was not updated, because that update is a push to `main` and this brief forbids it.

## Findings

| # | Severity | Area | Finding | Evidence / repro | Fix |
|---|---|---|---|---|---|
| 1 | P1 | Sign-in | Tapping Forgot Password before the status reads "Secure sign-in" throws and the screen shows the raw message `Cannot read properties of null (reading 'resetPassword')`. | `?emulator=1`, landscape, tap Forgot while the status still says "Checking security...". Empty email is fine and says to enter an email first. | Codex. In `wireAuth`, if the store is not ready, say "Still connecting. Try again in a moment." and ignore the tap. Do not edit `wireAuth` from this lane. |
| 2 | P1 | Sign-in | Forgot Password for an address with no account shows `Error: auth/user-not-found`. A known account gets the neutral "If an account exists…" sentence. A non-city address is rejected clearly. | Local Auth emulator, after "Secure sign-in". | Codex. Map `auth/user-not-found` on reset to the same neutral sentence. Do not show a raw `auth/` code. |
| 3 | P1 | Offline | A reload with no signal has nothing to show. The status line says "Offline: showing last update" only when the page is already open. There is no Firestore `persistentLocalCache`. | `setStatus` in `js/app.js`. `js/store.js` has no persistent cache. Going offline on an open demo page does switch the status to that sentence. | Codex, brief item 2. A copy change alone would still be a lie after refresh. |
| 4 | P1 fixed | Department email | On a phone held sideways, Copy message and Open in email sat below the dialog. The message box swallowed the scroll, so the actions were easy to miss. | Before: at 844×390 the buttons started at y=543 while the dialog ended at y=371. After `f26f510`: both buttons sit inside the dialog at 390×844, 844×390, 768×1024, and 1440×900. Copy still reports "Copied. Paste it into an email to the department." | `f26f510`. The message is capped with `min(320px, max(88px, calc(100svh - 300px)))`. Finalize & lock is inside the same short dialog. |
| 5 | P1 fixed | Sign-in | On a short landscape screen the card was centered and clipped. The title was off the top and the "if the link says it expired" note was off the bottom, and the overlay could not scroll. Create Account and Forgot Password were 15px tall. The email placeholder was 3.3:1. | After `d7e7ba7`, at 844×390 the logo and title are on screen at first paint (title top 125). The overlay scrolls (741px of content in a 390px screen) and the expired-link note can be brought fully on screen. Create Account and Forgot Password measure 44px tall. Placeholder contrast measures 6.22:1. Portrait, tablet, and desktop still fit without scrolling. | `d7e7ba7`. The overlay scrolls instead of clipping. The same rule covers the verify dialog. Placeholder opacity was removed. |
| 6 | P1 fixed | Crew | Change, the only control that switches a crew member's unit, was 50×15px. | After `a549a83`, on a 390×844 crew My Unit screen, Change is 66×44 and its top (244) is below the tab bar (205). It does not overlap the tabs. | `a549a83`. |
| 7 | P2 | Contrast | Small section labels on the party card are gray `#94a3b8` on white, 2.56:1. The party name and address beside them are 14.61:1. | Open any demo party on the desktop detail card and read a section label. | Leave for after the event. Do not restyle the Water-Shutoff palette tonight. |
| 8 | P2 | Tap targets | Many controls are under 44px: map chips 22px, icon buttons 30px, the ? button 36px, Finalize in the landscape header about 35px, the QR Close button 37px, verify Resend and Sign out 41px, Authenticate 40px. | Measured across the four viewports. | Leave tonight. The phone assign path is the row, then the pin. The controls people must hit to get in or to change unit are the ones above. |
| 9 | P2 | Copy | The button says Authenticate or Register. The link says Create Account or Sign in. The header says Sign out. The field placeholder says USER EMAIL. A screen reader already hears "City email" and "Password". | Sign-in card and the accessibility tree of `#login-form`. | Wording only. Not blocking. |
| 10 | P2 | Department email | The mailto link is 1,914 characters (body 1,291). That is under the old roughly 2,083 limit and close to lengths that open a blank draft in some mail apps. | Built from the subject and body after Finalize, every viewport. The click was blocked so Mail was not opened. Copy worked. | Copy is the fallback and it works. A hint can wait. |
| 11 | P2 | Walkthrough | All 8 role × viewport tours finished (Command 12 steps, Crew 6). One phone-portrait Command card was flagged about a pixel past the bottom edge; Skip, Back, and Next were still visible. The last step renders an empty Skip button. The tour card removes its focus outline. | `?tour=1` at all four sizes, both roles. | After the event. |
| 12 | P2 | Legend | Opening the legend on a landscape phone covers the time filter. It does not cover it in portrait. The legend is closed by default. | 844×390 and 390×844, legend opened. | After the event. |
| 13 | P2 | QR | The QR dialog fits portrait and landscape. The code draws and Close dismisses it. Close is 37px tall. | `#qr-fab` at both phone sizes. | No change. |
| 14 | P2 | Demo sign-out | In demo mode, Sign out calls the auth callback with the same demo user, so the map stays open. | `demoStore.signOut` in `js/store.js`. | Codex. Demo only. The event path is the real sign-out. |

Also still Codex, not re-fixed here: "Live · synced" is set on any party snapshot, including a cache hit (brief item 1). Moving a unit is still two writes (brief item 3). Security items 4 through 9 stay in that lane.

## What was tested

Demo mode at 390×844, 844×390, 768×1024, and 1440×900, for Command and Crew.

- Mouse: assign, move to a different party, unassign onto the remove zone, tap-to-assign, then disarm.
- Touch: drag on both phone orientations, then tap-to-assign on both.
- Walkthrough for both roles at all four sizes. Keyboard: Tab through the desktop header and the first unit rows, Enter to arm a unit, Escape to disarm. The ? control is a button in that tab order. Pressing the ? key does not start the tour, and the interface does not claim that it does.
- Finalize: accept every item, lock, open the department email, Copy, and confirm the mailto string without opening Mail. Unlock was exercised on the earlier pass.
- Import dialog opened at all four sizes. On landscape the confirm button is on screen.
- My Unit, including Change, and the citywide coverage table.
- Legend open and closed. QR open and close.
- Sign-in at all four sizes. Placeholder, Forgot, Create Account, and the expired-link note.
- Local Auth emulator only (`demo-nno` on 127.0.0.1:9099): create account, sign in while unverified, verify dialog at all four sizes, Resend toast "Verification email sent", Forgot for a known account, an unknown account, a non-city address, and an empty field.
- `&live=18:15` shows a Live now filter and 7 live pins.
- Throttled 4G (1.6 Mbps down, 750 Kbps up, 150 ms, cache disabled): DOMContentLoaded about 3.3s, pins ready about 3.3s. Tailwind, the department logo, and the QR script dominate.
- Contrast measured on the sign-in card, the sidebar hint, and an open party card. See the table.
- Accessibility tree of the sign-in form, not VoiceOver.
- Impeccable detect on `index.html`, `css/app.css`, `js/app.js`, and `js/tour.js`. Exit code 2. The repeated "#000 on #152a40" hit has no element and does not match the measured pairs. Inter, the compact header, the pulse, and the navy shadow are the existing Water-Shutoff look. No redesign.
- Live site, read-only, 2026-10-05 16:42 UTC: HTTP 200, `last-modified` Mon, 05 Oct 2026 14:41:35 GMT, `cache-control: max-age=600`.

## What was not tested, and why

- VoiceOver was not turned on. It takes over the Mac. The sign-in form was checked through Chrome's accessibility tree instead.
- No physical iPhone (Safari) or Android (Chrome) was available. Phone sizes are Chrome viewports, including a touch-event drag.
- The Firestore emulator and rules tests need Java, which is not installed. Those files are Codex's.
- No production account was created, and nothing was written to production. The verification link in the emulator was not opened, so the "page continues on its own" moment was not watched.
- Mail was not allowed to open the mailto link.
- An offline reload of the live map was not attempted. The status sentence was checked on an already-open demo page.
- A full reload while `navigator.onLine` is false cannot be served by the local static server, which is the same gap as item 3.

## Commits on `grok/audit-2026-10-05`

- `f26f510` fix(ui): keep department-email actions on a short screen
- `d7e7ba7` fix(ui): let the sign-in card scroll on a short screen
- `a549a83` fix(ui): make Change unit a full tap target

`a549a83` also stamps the cache query to `202610051140`. Not pushed. Not merged.
