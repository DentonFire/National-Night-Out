import { firebaseConfig, EVENT, MAP_CENTER, ALLOWED_EMAIL_DOMAIN } from "./config.js";
import { STATIONS, UNITS, TYPE_LABEL } from "./roster.js";
import { vehicleSVG, mayorSVG } from "./icons.js";
import { loadDistricts, fireDistrictAt } from "./geo.js";
import { firebaseStore, demoStore, isCityEmail } from "./store.js";
import { parseWorkbook, fillMissingPins } from "./importer.js";
import { runTour, seenTour } from "./tour.js";

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DEMO = params.has("demo");
const isMobile = () => matchMedia("(max-width: 1023px)").matches;

const S = {
  store: null,
  user: null,
  role: "crew",
  parties: [],
  byId: new Map(),
  selectedParty: null,
  selectedUnit: null,
  armedUnit: null,
  timeFilter: "all",
  tab: "units",
  movingPin: null,
  map: null,
  markers: new Map(),
  markerHtml: new Map(),
  districtLayer: null,
  districtLabels: [],
  routeLine: null,
  unsubscribe: null,
  lastSync: null,
  sync: { parties: null, event: null },
  syncErrors: { parties: null, event: null },
  myUnit: null,
  event: {},
  unsubEvent: null,
  tabRole: null,
};
const MY_UNIT_KEY = "nno-my-unit";
try { const u = localStorage.getItem(MY_UNIT_KEY); if (UNITS.has(u)) S.myUnit = u; } catch { /* storage blocked */ }
const isCommand = () => S.role === "command" || S.role === "owner";
// Command can change assignments only while the map isn't finalized (locked).
const canEdit = () => isCommand() && !S.event.finalized;
// The unit the map is drawn around: one picked in the roster, else a crew member's own unit.
const focusUnit = () => S.selectedUnit || (!isCommand() ? S.myUnit : null);

// ------------------------------------------------------------- helpers

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function fmtTime(hhmm) {
  if (!hhmm) return "—";
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")}`;
}
const fmtRange = p => `${fmtTime(p.start)}–${fmtTime(p.end)} p.m.`;
const minutes = hhmm => { const [h, m] = (hhmm || "0:0").split(":").map(Number); return h * 60 + m; };

// Pin color by start time. Red is reserved for "needs a unit".
const TIME_COLORS = ["#2563eb", "#0d9488", "#7c3aed", "#ea580c", "#0891b2", "#a16207"];
let startSlots = [];
const timeColor = start => TIME_COLORS[startSlots.indexOf(start)] || "#152a40";

const fdUnits = p => (p.units || []).filter(u => UNITS.has(u));
const isOut = (unitId, p) => p.fireDistrict != null && String(UNITS.get(unitId)?.station) !== String(p.fireDistrict);
const stopsFor = unitId => S.parties.filter(p => (p.units || []).includes(unitId)).sort(byTime);
function byTime(a, b) { return minutes(a.start) - minutes(b.start) || a.name.localeCompare(b.name); }

function isEventNight() {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return today === EVENT.date || params.has("live");
}
function nowMinutes() {
  const t = params.get("live");
  if (t && /^\d{1,2}:\d{2}$/.test(t)) return minutes(t);
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
const isLive = p => isEventNight() && nowMinutes() >= minutes(p.start) && nowMinutes() < minutes(p.end);

function chipHTML(unitId, { party, draggable, title, from } = {}) {
  const u = UNITS.get(unitId);
  if (!u) return "";
  const out = party && isOut(unitId, party);
  const mine = !isCommand() && unitId === S.myUnit;
  const t = title || `${TYPE_LABEL[u.type]} ${unitId}, Station ${u.station}${out ? `, out of district (home District ${u.station})` : ""}`;
  const focus = isCommand() && unitId === S.selectedUnit;
  const hint = draggable ? (from ? ". Drag to another party to move it, or to the roster to remove it" : ". Drag onto a party to assign") : "";
  return `<span class="chip${out ? " out" : ""}${mine ? " mine" : ""}${focus ? " focus" : ""}${draggable ? " draggable" : ""}" data-unit="${unitId}"${from ? ` data-from="${esc(from)}"` : ""} title="${esc(t + hint)}" aria-label="${esc(t)}">${vehicleSVG(u.type)}${unitId}</span>`;
}
const pdChip = () => `<span class="chip pd" title="Denton Police">${vehicleSVG("police")}PD</span>`;
const mayorChip = () => `<span class="chip mayor sq" title="Mayor">${mayorSVG()}MAYOR</span>`;

let toastTimer;
function toast(text, error = false) {
  const el = $("toast");
  el.textContent = text;
  el.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), 3200);
}
const fail = e => { console.error(e); toast(e.code === "permission-denied" ? "You don't have permission to change that." : `Couldn't save: ${e.code || e.message}`, true); };

// ------------------------------------------------------------- auth

let signUpMode = false;
let verifyTimer = null;

function loginMsg(text, ok = false) {
  const el = $("login-msg");
  el.textContent = text;
  el.className = `font-bold text-xs py-1.5 px-2 rounded border ${ok ? "msg-ok" : "msg-error"}`;
}

function wireAuth() {
  $("login-form").addEventListener("submit", async e => {
    e.preventDefault();
    const email = $("email").value.trim().toLowerCase();
    const password = $("password").value;
    if (!email || !password) return loginMsg("Enter your email and password");
    if (!isCityEmail(email)) return loginMsg(`Restricted: ${ALLOWED_EMAIL_DOMAIN} email required`);
    const btn = $("login-btn");
    btn.disabled = true;
    btn.textContent = "Processing...";
    try {
      if (signUpMode) {
        await S.store.signUp(email, password);
        setSignUpMode(false);
        loginMsg(`Account created. Open the link sent to ${email}, then sign in. If the link says it expired or was already used, city email security opened it first: you are verified, just sign in.`, true);
      } else {
        await S.store.signIn(email, password);
      }
    } catch (err) {
      const map = {
        "auth/invalid-credential": "Wrong email or password",
        "auth/wrong-password": "Wrong email or password",
        "auth/user-not-found": "Wrong email or password",
        "auth/email-already-in-use": "That email already has an account. Sign in instead.",
        "auth/weak-password": "Use at least 6 characters",
        "auth/too-many-requests": "Too many attempts. Wait a few minutes and try again",
        "auth/network-request-failed": "No connection. Check your signal and try again",
      };
      loginMsg(map[err.code] || `Error: ${err.code || err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = signUpMode ? "Register" : "Authenticate";
    }
  });

  $("auth-toggle").addEventListener("click", () => setSignUpMode(!signUpMode));

  $("forgot-btn").addEventListener("click", async () => {
    const email = $("email").value.trim().toLowerCase();
    if (!email) { loginMsg("Enter your email above, then tap Forgot Password"); $("email").focus(); return; }
    if (!isCityEmail(email)) return loginMsg(`Must be a ${ALLOWED_EMAIL_DOMAIN} email`);
    const btn = $("forgot-btn");
    btn.disabled = true;
    btn.textContent = "Sending...";
    try {
      await S.store.resetPassword(email);
      loginMsg(`If an account exists for ${email}, a reset link is on its way. Check Junk or Quarantine too.`, true);
    } catch (err) {
      loginMsg(err.code === "auth/too-many-requests" ? "Too many attempts. Wait a few minutes and try again" : `Error: ${err.code || err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "Forgot Password?";
    }
  });

  $("verify-resend").addEventListener("click", () =>
    S.store.resendVerification().then(() => toast("Verification email sent")).catch(fail));
  $("verify-cancel").addEventListener("click", signOut);
  $("logout-btn").addEventListener("click", () => { if (DEMO || confirm("Sign out of the NNO map?")) signOut(); });
}

function setSignUpMode(on) {
  signUpMode = on;
  $("auth-mode-title").textContent = on ? "Create Account" : "National Night Out";
  $("login-btn").textContent = on ? "Register" : "Authenticate";
  $("auth-toggle").innerHTML = on ? "Have an account? <span class='underline'>Sign In</span>" : "Need access? <span class='underline'>Create Account</span>";
  $("password").autocomplete = on ? "new-password" : "current-password";
  $("login-msg").classList.add("hidden");
}

async function signOut() {
  if (!DEMO) handleAuth({ user: null }); // Clear the screen before the auth operation can fail.
  try { await S.store.signOut(); }
  catch (err) { toast("Couldn't finish signing out. Reload and sign out again.", true); }
}

function clearAuthState() {
  S.user = null; S.role = "crew";
  S.unsubscribe?.(); S.unsubscribe = null;
  S.unsubEvent?.(); S.unsubEvent = null;
  // Let the tour clean up its keyboard/resize handlers before clearing its seen-state.
  if ($("tour")) document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
  disarm(); stopEdgePan();
  S.map?.remove(); S.map = null;
  S.markers.clear(); S.markerHtml.clear(); S.routeLine = null;
  S.districtLayer = null; S.districtLabels = [];
  S.parties = []; S.byId.clear(); S.event = {};
  S.selectedParty = null; S.selectedUnit = null; S.movingPin = null;
  S.myUnit = null; S.tabRole = null; S.timeFilter = "all"; S.lastSync = null;
  S.sync = { parties: null, event: null }; S.syncErrors = { parties: null, event: null };
  tourChecked = null;
  for (const id of ["mine-pane", "units-pane", "parties-pane", "coverage-pane", "detail", "access-list", "import-preview"]) $(id).replaceChildren();
  $("password").value = ""; $("verify-target").textContent = "";
  $("map-loading").classList.remove("hidden");
  try {
    for (const key of [MY_UNIT_KEY, "nno-tour-crew-v1", "nno-tour-command-v1"]) localStorage.removeItem(key);
  } catch { /* storage blocked */ }
}

function handleAuth({ user, unverified, role }) {
  clearInterval(verifyTimer);
  $("verify-modal").classList.add("hidden");
  if (!user) {
    clearAuthState();
    $("app").classList.add("hidden");
    $("app").classList.remove("flex");
    $("login-overlay").style.display = "flex";
    $("secure-light").className = "w-2 h-2 rounded-full bg-yellow-400 animate-pulse";
    $("secure-text").textContent = "Secure sign-in";
    return;
  }
  if (S.user && S.user !== user) clearAuthState();
  if (unverified) {
    $("app").classList.add("hidden");
    $("verify-target").textContent = user.email;
    $("verify-modal").classList.remove("hidden");
    verifyTimer = setInterval(async () => {
      try {
        if (await S.store.reloadUser()) { clearInterval(verifyTimer); location.reload(); }
      } catch (err) {
        // A lost signal must not stop verification polling or leave an unhandled rejection.
        if (err.code !== "auth/network-request-failed") {
          clearInterval(verifyTimer);
          toast("Couldn't check verification. Sign out and sign in again.", true);
        }
      }
    }, 3000);
    return;
  }
  S.user = user;
  S.role = role || "crew";
  $("login-overlay").style.display = "none";
  $("app").classList.remove("hidden");
  $("app").classList.add("flex");
  startApp();
}

// ------------------------------------------------------------- app

function startApp() {
  const activeUser = S.user;
  const cmd = isCommand();
  $("role-pill").textContent = cmd ? "Command" : "Crew";
  $("role-pill").className = `hidden xl:inline-block text-[9px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full ${cmd ? "bg-navy text-yellow" : "bg-slate-100 text-slate-500"}`;
  $("finalize-btn").classList.toggle("hidden", !cmd);
  $("finalize-btn").classList.toggle("flex", cmd);
  const owner = S.role === "owner" && !DEMO;
  $("access-btn").classList.toggle("hidden", !owner);
  $("access-btn").classList.toggle("flex", owner);
  $("tab-mine").classList.toggle("hidden", cmd);
  $("tab-coverage").classList.toggle("hidden", !cmd);
  if (S.tabRole !== cmd) {
    S.tabRole = cmd;
    setTab(cmd ? "units" : "mine");
    if (!cmd && isMobile()) openSidebar(); // crews land on their answer, not the map
  }
  $("sidebar-hint").innerHTML = cmd
    ? "<b class='text-white'>Drag a unit onto a party</b>, or tap a unit and then tap parties. A unit can cover several parties."
    : "Tap a unit to see its stops. Tap a party for details and directions.";
  if (DEMO) {
    document.querySelectorAll(".demo-role").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.demoRole === (cmd ? "command" : "crew"))));
  }
  if (!cmd) disarm();

  initMap();
  if (!S.unsubEvent) {
    S.unsubEvent = S.store.subscribeEvent((ev, metadata) => {
      if (S.user !== activeUser) return;
      S.sync.event = metadata || { fromCache: false, hasPendingWrites: false };
      S.syncErrors.event = null;
      const wasFinal = Boolean(S.event.finalized);
      S.event = ev || {};
      if (S.event.finalized && !wasFinal) { disarm(); S.selectedUnit = null; S.movingPin && cancelMovePin(); }
      applyLock();
      render();
    }, err => {
      console.error(err);
      S.syncErrors.event = "Can't confirm map lock";
      setStatus(false);
    });
  }
  applyLock();
  if (!S.unsubscribe) {
    S.unsubscribe = S.store.subscribeParties((parties, metadata) => {
      if (S.user !== activeUser) return;
      S.sync.parties = metadata || { fromCache: false, hasPendingWrites: false };
      S.syncErrors.parties = null;
      S.parties = parties.sort(byTime);
      S.byId = new Map(parties.map(p => [p.id, p]));
      if (S.selectedParty && !S.byId.has(S.selectedParty)) S.selectedParty = null;
      if (!S.sync.parties.fromCache && !S.sync.parties.hasPendingWrites) S.lastSync = new Date();
      setStatus(true);
      $("map-loading").classList.add("hidden");
      render();
      maybeStartTour();
    }, err => {
      console.error(err);
      S.syncErrors.parties = err.code === "permission-denied" ? "No access: ask Command" : "Connection error";
      if (err.code === "permission-denied") {
        S.parties = []; S.byId.clear(); S.selectedParty = null; render();
      }
      setStatus(false);
      $("map-loading").classList.add("hidden");
    });
  } else {
    render();
  }
}

function setStatus() {
  const snapshots = Object.values(S.sync);
  const error = S.syncErrors.parties || S.syncErrors.event;
  const pending = snapshots.some(m => m?.hasPendingWrites);
  const cached = snapshots.some(m => m?.fromCache);
  const connected = snapshots.every(Boolean) && !pending && !cached && !error && navigator.onLine;
  $("status-dot").className = `w-2 h-2 rounded-full ${error ? "bg-red" : DEMO || connected ? "bg-green-500" : "bg-yellow-400"}`;
  const when = S.lastSync ? S.lastSync.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  $("status-text").textContent = DEMO ? "Demo data"
    : error ? error
    : !navigator.onLine ? (when ? `Offline · last update ${when}` : "Offline · no confirmed data")
    : pending ? "Saving changes..."
    : cached ? (when ? `Cached · last update ${when}` : "Connecting · no confirmed data")
    : !connected ? "Connecting..."
    : `Live · synced ${when}`;
}
addEventListener("online", setStatus);
addEventListener("offline", setStatus);

// ------------------------------------------------------------- map

function initMap() {
  if (S.map) { setTimeout(() => S.map?.invalidateSize(), 50); return; }
  S.map = L.map("map", { zoomControl: false, attributionControl: true }).setView(MAP_CENTER, 12);
  // CARTO basemaps started requiring an API key in 2026; Esri's street map needs none.
  // Light gray base + street labels keeps colored pins and unit chips readable.
  const esri = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas";
  L.tileLayer(`${esri}/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`, {
    attribution: "Tiles &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors", maxZoom: 16,
  }).addTo(S.map);
  L.tileLayer(`${esri}/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 16, pane: "overlayPane" }).addTo(S.map);
  L.control.zoom({ position: "bottomright" }).addTo(S.map);

  S.map.createPane("districtLabels").style.zIndex = 450; // above shapes, below pins (600)
  const activeMap = S.map;
  loadDistricts().then(geo => {
    if (!S.user || S.map !== activeMap) return;
    S.districtLayer = L.geoJSON(geo, { style: districtStyle, interactive: false }).addTo(S.map);
    S.districtLabels = geo.features.map(f => {
      const id = String(f.properties.districtid);
      const m = L.marker(centroid(f.geometry), {
        icon: L.divIcon({ className: "district-label", html: `D${id}`, iconSize: [40, 16], iconAnchor: [20, 8] }),
        interactive: false, keyboard: false, pane: "districtLabels",
      }).addTo(S.map);
      m.districtId = id;
      return m;
    });
    if (!S.parties.length) S.map.fitBounds(S.districtLayer.getBounds(), { padding: [20, 20] });
  });

  const syncLabels = () => $("map").classList.toggle("show-labels", S.map.getZoom() >= 14);
  S.map.on("zoomend", syncLabels);
  S.map.on("click", () => { if (!S.movingPin) selectParty(null); });
  setTimeout(() => S.map?.invalidateSize(), 50);
}

function districtStyle(f) {
  const home = focusUnit() && String(UNITS.get(focusUnit())?.station) === String(f.properties.districtid);
  return { color: "#152a40", weight: home ? 2.5 : 1.4, opacity: home ? 0.9 : 0.45, dashArray: home ? null : "4 4", fillColor: home ? "#f9c031" : "#152a40", fillOpacity: home ? 0.14 : 0.02 };
}

function centroid(g) {
  const ring = g.type === "Polygon" ? g.coordinates[0] : g.coordinates[0][0];
  let a = 0, x = 0, y = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
    const c = x0 * y1 - x1 * y0;
    a += c; x += (x0 + x1) * c; y += (y0 + y1) * c;
  }
  a /= 2;
  return [y / (6 * a), x / (6 * a)];
}

function pinSVG(color) {
  return `<svg viewBox="0 0 34 42" aria-hidden="true"><path d="M17 41c-.6 0-1.1-.3-1.4-.8C10 31.4 2 25.6 2 16.5 2 8 8.7 1.5 17 1.5S32 8 32 16.5c0 9.1-8 14.9-13.6 23.7-.3.5-.8.8-1.4.8z" fill="${color}" stroke="#fff" stroke-width="2"/></svg>`;
}

function markerHTML(p) {
  const units = fdUnits(p);
  const need = units.length === 0;
  const visible = S.timeFilter === "all" || (S.timeFilter === "now" ? isLive(p) : p.start === S.timeFilter);
  const cmd = canEdit();
  const has = S.selectedUnit && (p.units || []).includes(S.selectedUnit);
  // Crews: picking a unit dims everything else. Command: picking a unit means "where does it go",
  // so every party lights up as a drop target.
  const unitDim = !cmd && S.selectedUnit && !has;
  const target = cmd && S.selectedUnit && visible;
  const cls = ["pm", need && "need", !visible || unitDim ? "dim" : "", target && "target", has && "has-unit", S.selectedParty === p.id && "selected", isLive(p) && "live"].filter(Boolean).join(" ");
  const chips = units.map(u => chipHTML(u, { party: p, draggable: cmd, from: p.id })).join("") + (p.police ? pdChip() : "") + (p.mayor ? mayorChip() : "");
  return `<div class="${cls}" data-party="${esc(p.id)}">
    <div class="pm-pin" title="${esc(p.name)}">${pinSVG(timeColor(p.start))}<span class="t">${fmtTime(p.start)}</span><span class="pm-label">${esc(p.name)}</span></div>
    <div class="pm-units">${chips}</div>
  </div>`;
}

function renderMarkers() {
  const seen = new Set();
  for (const p of S.parties) {
    if (p.lat == null || p.lng == null) continue;
    seen.add(p.id);
    const html = markerHTML(p);
    let m = S.markers.get(p.id);
    const icon = () => L.divIcon({ className: "pm-wrap", html, iconSize: [34, 42], iconAnchor: [17, 42] });
    if (!m) {
      m = L.marker([p.lat, p.lng], { icon: icon(), keyboard: true, title: p.name, riseOnHover: true }).addTo(S.map);
      m.on("click", e => { L.DomEvent.stopPropagation(e); onPartyTap(m.partyId); });
      m.on("dragend", () => onPinDragged(m));
      S.markers.set(p.id, m);
    } else if (S.movingPin?.id !== p.id) {
      m.setLatLng([p.lat, p.lng]);
    }
    m.partyId = p.id;
    if (S.markerHtml.get(p.id) !== html) { m.setIcon(icon()); S.markerHtml.set(p.id, html); }
    m.setZIndexOffset(S.selectedParty === p.id ? 1000 : 0);
  }
  for (const [id, m] of S.markers) if (!seen.has(id)) { m.remove(); S.markers.delete(id); S.markerHtml.delete(id); }

  S.routeLine?.remove();
  S.routeLine = null;
  if (focusUnit()) {
    const pts = stopsFor(focusUnit()).filter(p => p.lat != null).map(p => [p.lat, p.lng]);
    if (pts.length > 1) S.routeLine = L.polyline(pts, { color: "#152a40", weight: 3, dashArray: "6 6", opacity: 0.8, interactive: false }).addTo(S.map);
  }
  S.districtLayer?.setStyle(districtStyle);
  for (const lbl of S.districtLabels) {
    const home = focusUnit() && String(UNITS.get(focusUnit())?.station) === lbl.districtId;
    lbl.getElement()?.classList.toggle("home", Boolean(home));
  }
}

// ------------------------------------------------------------- render

function render() {
  startSlots = [...new Set(S.parties.map(p => p.start).filter(Boolean))].sort((a, b) => minutes(a) - minutes(b));
  renderStats();
  renderTimeFilter();
  renderUnits();
  renderParties();
  renderMine();
  renderCoverage();
  renderMarkers();
  renderDetail();
  renderLegend();
  setStatus(true);
}

function renderStats() {
  const out = new Set(S.parties.flatMap(fdUnits));
  const open = S.parties.filter(p => fdUnits(p).length === 0).length;
  for (const [id, v] of [["parties", S.parties.length], ["units", out.size], ["open", open]]) {
    $(`stat-${id}`).textContent = v;
    $(`strip-${id}`).textContent = v;
  }
}

function renderTimeFilter() {
  const btn = (key, label, dot) =>
    `<button class="tf-btn" data-tf="${key}" aria-pressed="${S.timeFilter === key}">${dot ? `<span class="dot" style="background:${dot}"></span>` : ""}${label}</button>`;
  $("time-filter").innerHTML =
    btn("all", "All times") +
    (isEventNight() ? btn("now", "Live now", "#22c55e") : "") +
    startSlots.map(s => btn(s, fmtTime(s), timeColor(s))).join("");
}

function renderUnits() {
  const cmd = canEdit();
  $("units-pane").innerHTML = STATIONS.map(st => `
    <div class="station-head"><h3>Station ${st.station}</h3><span>District ${st.station}</span></div>
    ${st.units.map(([id]) => {
      const stops = stopsFor(id);
      const list = stops.length
        ? stops.map(p => `<b>${fmtTime(p.start)}</b> ${esc(p.name)}${isOut(id, p) ? " <span class='text-yellow'>(out)</span>" : ""}`).join("<br>")
        : `<span class="opacity-60">${cmd ? "Not assigned" : "No stops"}</span>`;
      return `<div class="unit-row${S.selectedUnit === id ? " selected" : ""}" data-unit-row="${id}" role="button" tabindex="0" aria-pressed="${S.selectedUnit === id}">
        ${chipHTML(id, { draggable: cmd })}
        <div class="stops">${list}</div>
        <span class="count${stops.length ? "" : " zero"}" aria-label="${stops.length} stops">${stops.length}</span>
      </div>`;
    }).join("")}
  `).join("");
}

function renderParties() {
  const pane = $("parties-pane");
  if (!S.parties.length) {
    pane.innerHTML = `<div class="p-6 text-center text-blue-100/80 text-sm">${isCommand() ? "No parties yet. Use <b class='text-white'>Import</b> to load the spreadsheet from the Community Risk Reduction Officer." : "No parties yet. Command will load them before the event."}</div>`;
    return;
  }
  pane.innerHTML = S.parties.map(p => {
    const units = fdUnits(p);
    const chips = units.map(u => chipHTML(u, { party: p, draggable: canEdit(), from: p.id })).join("") + (p.police ? pdChip() : "") + (p.mayor ? mayorChip() : "");
    return `<button class="party-row${S.selectedParty === p.id ? " selected" : ""}" data-party="${esc(p.id)}">
      <div class="flex items-center justify-between gap-2">
        <span class="time-tag"><i style="background:${timeColor(p.start)}"></i>${fmtRange(p)}</span>
        ${isLive(p) ? "<span class='text-[9px] font-black uppercase tracking-widest text-green-300'>Live</span>" : ""}
      </div>
      <div class="font-extrabold text-[13px] leading-tight mt-1">${esc(p.name)}</div>
      <div class="meta mt-1">${p.fireDistrict ? `Fire District ${esc(p.fireDistrict)}` : "<span class='text-yellow'>No fire district</span>"} · Council ${esc(p.council || "—")}${p.attendance ? ` · ~${esc(p.attendance)}` : ""}</div>
      <div class="chips">${chips}${units.length ? "" : "<span class='need'>Needs a unit</span>"}</div>
    </button>`;
  }).join("");
}

function renderLegend() {
  $("legend-body").innerHTML = `
    <div class="flex flex-wrap gap-1.5">${startSlots.map(s => `<span class="time-tag text-navy"><i style="background:${timeColor(s)}"></i>${fmtTime(s)}</span>`).join("")}</div>
    <p class="text-slate-500">Pin color is the party's start time. A pulsing red ring means no fire unit yet.</p>
    <div class="flex flex-wrap gap-1.5">
      <span class="chip">${vehicleSVG("engine")}E</span><span class="chip">${vehicleSVG("aerial")}T/L</span><span class="chip">${vehicleSVG("medic")}M</span>
      <span class="chip out">${vehicleSVG("engine")}E6</span>${pdChip()}${mayorChip()}
    </div>
    <p class="text-slate-500"><b class="text-navy">Yellow + OUT</b>: the unit is outside its home district (the number is its station and district). Dashed lines are fire district boundaries.</p>`;
}

function renderDetail() {
  const el = $("detail");
  const p = S.selectedParty && S.byId.get(S.selectedParty);
  $("qr-fab").classList.toggle("hidden", Boolean(p) && isMobile());
  if (!p) { el.classList.add("hidden"); el.classList.remove("flex"); return; }
  el.classList.remove("hidden");
  el.classList.add("flex");
  const cmd = canEdit();
  const units = fdUnits(p);
  const others = (p.depts || []).filter(d => !/^(fire|police|other)$/i.test(d));
  const moving = S.movingPin?.id === p.id;
  const sameStart = u => stopsFor(u).filter(q => q.id !== p.id && q.start === p.start).map(q => q.name);
  const unassigned = [...UNITS.keys()].filter(u => !units.includes(u));
  const nav = p.lat != null
    ? `<div class="grid grid-cols-2 gap-2 mt-3">
        <a class="bg-navy text-white text-center font-black py-2.5 rounded-lg text-[10px] uppercase tracking-widest hover:bg-navy-light" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}">Google Maps</a>
        <a class="bg-slate-100 text-navy text-center font-black py-2.5 rounded-lg text-[10px] uppercase tracking-widest hover:bg-slate-200" target="_blank" rel="noopener" href="https://maps.apple.com/?daddr=${p.lat},${p.lng}">Apple Maps</a>
      </div>` : `<p class="mt-3 text-xs font-bold text-red">No map pin yet.${cmd ? " Use Move pin below." : ""}</p>`;

  el.innerHTML = `
    <div class="detail-head">
      <button id="detail-close" class="absolute top-3 right-3 text-white/70 hover:text-white p-1.5" aria-label="Close details"><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg></button>
      <span class="time-tag text-yellow"><i style="background:${timeColor(p.start)}"></i>${fmtRange(p)}${isLive(p) ? " · <span class='text-green-300'>LIVE</span>" : ""}</span>
      <h2 class="text-lg font-black leading-tight mt-1 pr-8">${esc(p.name)}</h2>
      <div class="flex flex-wrap gap-1.5 mt-2.5">
        <span class="tagline !bg-white/10 !text-white">${p.fireDistrict ? `Fire District ${esc(p.fireDistrict)}` : "Outside DFD districts"}</span>
        <span class="tagline !bg-white/10 !text-white">Council District ${esc(p.council || "—")}</span>
        ${p.attendance ? `<span class="tagline !bg-white/10 !text-white">~${esc(p.attendance)} expected</span>` : ""}
      </div>
    </div>
    <div class="detail-body">
      <p class="text-sm font-semibold text-navy leading-snug">${esc(p.address)}</p>
      ${p.notes ? `<p class="text-xs text-slate-500 mt-1 leading-snug">${esc(p.notes)}</p>` : ""}
      ${p.pinApprox && !p.pinMoved ? `<p class="text-xs font-bold text-amber-600 mt-2">Pin placed from the street address and may be off.${cmd ? " Use Move pin to set the exact spot." : ""}</p>` : ""}
      ${nav}

      <div class="mt-6 section-label">Fire units</div>
      <div>${units.length ? units.map(u => {
        const unit = UNITS.get(u);
        const out = isOut(u, p);
        const clash = sameStart(u);
        return `<div class="attend-row">${chipHTML(u, { party: p })}
          <div class="info"><b>${TYPE_LABEL[unit.type]} · Station ${unit.station}</b>${out ? `<br><span class="text-amber-600 font-bold">Out of district (home District ${unit.station})</span>` : ""}${clash.length ? `<br><span class="text-amber-600">Same start time as ${esc(clash.join(", "))}</span>` : ""}</div>
          ${cmd ? `<button class="icon-btn" data-unassign="${u}" aria-label="Remove ${u} from this party"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M6 18L18 6M6 6l12 12"/></svg></button>` : ""}
        </div>`;
      }).join("") : `<p class="text-xs font-bold text-red">No fire unit assigned yet.</p>`}</div>
      ${cmd ? `<div class="mt-3 flex gap-2">
          <label class="sr-only" for="add-unit">Add a unit</label>
          <select id="add-unit" class="flex-1 bg-slate-50 border border-slate-200 p-2.5 rounded-lg text-sm font-semibold">
            <option value="">Add a unit…</option>
            ${STATIONS.map(st => `<optgroup label="Station ${st.station}">${st.units.filter(([id]) => unassigned.includes(id)).map(([id, type]) => `<option value="${id}">${id} · ${TYPE_LABEL[type]}</option>`).join("")}</optgroup>`).join("")}
          </select>
          <button id="add-unit-btn" class="bg-navy text-white font-black px-4 rounded-lg text-[10px] uppercase tracking-widest">Add</button>
        </div>` : ""}

      <div class="mt-6 section-label">Also attending</div>
      ${p.police ? `<div class="attend-row">${pdChip()}<div class="info"><b>Denton Police</b><br>Requested by the host</div></div>` : ""}
      <div class="attend-row">${p.mayor ? mayorChip() : `<span class="chip sq opacity-40">${mayorSVG()}MAYOR</span>`}
        <div class="info"><b>${p.mayor ? "Mayor attending" : "Mayor not scheduled"}</b></div>
        ${cmd ? `<label class="switch" aria-label="Mayor attending"><input id="mayor-toggle" type="checkbox" ${p.mayor ? "checked" : ""}><span class="slider"></span></label>` : ""}
      </div>
      ${others.length ? `<div class="flex flex-wrap gap-1.5 mt-3">${others.map(d => `<span class="tagline">${esc(d)}</span>`).join("")}</div>` : ""}
      ${p.guests ? `<p class="text-xs text-slate-600 mt-3 leading-snug"><b class="text-navy">Host also asked for:</b> ${esc(p.guests)}</p>` : ""}

      ${cmd ? `<div class="mt-6 section-label">Command</div>
        ${moving
          ? `<p class="text-xs text-slate-600 mb-2">Drag the pin to the party's spot, then save.${S.movingPin.fd !== undefined ? ` New spot: <b>${S.movingPin.fd ? `Fire District ${S.movingPin.fd}` : "outside DFD districts"}</b>.` : ""}</p>
             <div class="flex gap-2"><button id="pin-save" class="flex-1 bg-navy text-white font-black py-2.5 rounded-lg text-[10px] uppercase tracking-widest">Save pin</button><button id="pin-cancel" class="flex-1 bg-slate-100 text-navy font-black py-2.5 rounded-lg text-[10px] uppercase tracking-widest">Cancel</button></div>`
          : `<div class="flex gap-2"><button id="pin-move" class="flex-1 bg-slate-100 text-navy font-black py-2.5 rounded-lg text-[10px] uppercase tracking-widest hover:bg-slate-200">Move pin</button><button id="party-remove" class="flex-1 bg-white border border-red-200 text-red font-black py-2.5 rounded-lg text-[10px] uppercase tracking-widest hover:bg-red-50">Remove party</button></div>`}` : ""}
    </div>`;
}

// ------------------------------------------------------------- my unit + coverage

function districtStats() {
  return STATIONS.map(st => {
    const d = String(st.station);
    const ps = S.parties.filter(p => String(p.fireDistrict) === d).sort(byTime);
    const units = [...new Set(ps.flatMap(fdUnits))].sort();
    return {
      d, parties: ps, home: st.units.map(([id]) => id), units,
      helpers: units.filter(u => String(UNITS.get(u).station) !== d),
      open: ps.filter(p => !fdUnits(p).length).length,
    };
  });
}

function coverageTable(stats, mineD) {
  const max = Math.max(1, ...stats.map(s => s.parties.length));
  return `<table class="cov">
    <thead><tr><th>District</th><th>Parties</th><th title="Units housed at that station">Home units</th><th title="Units assigned to parties there">Covering</th></tr></thead>
    <tbody>${stats.map(s => {
      const busy = s.parties.length > s.home.length;
      return `<tr class="${s.d === mineD ? "mine" : ""}">
        <td><b>D${s.d}</b>${s.d === mineD ? " <span class='you'>you</span>" : ""}</td>
        <td><span class="bar"><i style="width:${(s.parties.length / max) * 100}%" class="${busy ? "busy" : ""}"></i></span><b class="tnum">${s.parties.length}</b></td>
        <td class="tnum">${s.home.length}</td>
        <td class="tnum">${s.units.length}${s.helpers.length ? ` <span class="help">+${s.helpers.length} help</span>` : ""}${s.open ? ` <span class="open">${s.open} open</span>` : ""}</td>
      </tr>`;
    }).join("")}</tbody></table>`;
}

const navButtons = p => p.lat == null ? "" : `<div class="grid grid-cols-2 gap-1.5 mt-2.5">
  <a class="nav-btn" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}">Google Maps</a>
  <a class="nav-btn alt" target="_blank" rel="noopener" href="https://maps.apple.com/?daddr=${p.lat},${p.lng}">Apple Maps</a></div>`;

function renderMine() {
  const pane = $("mine-pane");
  if (isCommand()) { pane.innerHTML = ""; return; }
  if (!S.myUnit) {
    pane.innerHTML = `<div class="px-4 pt-4">
      <h3 class="text-white font-black text-base leading-tight">Which unit are you on tonight?</h3>
      <p class="text-[11px] text-blue-100/75 mt-1">Pick once. This phone remembers it.</p></div>
      ${STATIONS.map(st => `<div class="station-head"><h3>Station ${st.station}</h3></div>
        <div class="pick-grid">${st.units.map(([id, type]) => `<button class="pick" data-pick-unit="${id}">${vehicleSVG(type)}<span>${id}</span></button>`).join("")}</div>`).join("")}`;
    return;
  }
  const u = UNITS.get(S.myUnit);
  const d = String(u.station);
  const stops = stopsFor(S.myUnit);
  const stats = districtStats();
  const mine = stats.find(s => s.d === d);
  const statOf = dd => stats.find(s => s.d === String(dd));

  const stopCards = stops.length ? stops.map((p, i) => {
    const out = isOut(S.myUnit, p);
    const st = statOf(p.fireDistrict);
    const why = out
      ? `<p class="why">Helping <b>District ${esc(p.fireDistrict)}</b>: ${st ? `${st.parties.length} part${st.parties.length === 1 ? "y" : "ies"}, ${st.home.length} home unit${st.home.length === 1 ? "" : "s"}` : "outside your district"}.</p>`
      : `<p class="why home">In your district.</p>`;
    return `<div class="stop-card${out ? " out" : ""}" data-party="${esc(p.id)}" role="button" tabindex="0">
      <div class="flex items-center justify-between gap-2">
        <span class="time-tag text-white"><i style="background:${timeColor(p.start)}"></i>${i + 1}. ${fmtRange(p)}</span>
        ${isLive(p) ? "<span class='text-[9px] font-black uppercase tracking-widest text-green-300'>Live</span>" : ""}
      </div>
      <div class="font-extrabold text-[15px] leading-tight mt-1.5 text-white">${esc(p.name)}</div>
      <div class="text-[11px] text-blue-100/80 mt-0.5 leading-snug">${esc(p.address)}</div>
      ${why}${navButtons(p)}
    </div>`;
  }).join("") : `<div class="empty-card"><b>No stops assigned yet.</b><br>Command is still assigning units. This updates on its own.</div>`;

  const others = mine.units.filter(x => x !== S.myUnit);
  const coveringList = mine.parties.length ? mine.parties.map(p => {
    const units = fdUnits(p);
    return `<button class="mini-row" data-party="${esc(p.id)}">
      <span class="time-tag text-white"><i style="background:${timeColor(p.start)}"></i>${fmtTime(p.start)}</span>
      <span class="flex-1 min-w-0 truncate">${esc(p.name)}</span>
      <span class="flex gap-1 shrink-0">${units.length ? units.map(x => chipHTML(x, { party: p })).join("") : "<span class='need'>Open</span>"}</span>
    </button>`;
  }).join("") : `<p class="px-4 text-[12px] text-blue-100/80">No parties in District ${d} this year.${stops.some(p => isOut(S.myUnit, p)) ? " That's why you're helping elsewhere." : ""}</p>`;

  pane.innerHTML = `
    <div class="my-head">
      <div class="flex items-center gap-2.5">${chipHTML(S.myUnit)}<div class="leading-tight"><div class="text-white font-black text-sm">${TYPE_LABEL[u.type]} ${S.myUnit}</div><div class="text-[10px] font-bold uppercase tracking-widest text-blue-100/70">Station ${d} · District ${d}</div></div></div>
      <button class="text-[10px] font-black uppercase tracking-widest text-yellow underline" data-change-unit>Change</button>
    </div>
    <p class="px-4 mt-2 text-[11px] font-bold ${S.event.finalized ? "text-green-300" : "text-yellow"}">${S.event.finalized ? `Assignments are final${S.event.finalizedAt ? ` as of ${fmtWhen(S.event.finalizedAt)}` : ""}.` : "Chiefs are still assigning. This may change."}</p>
    <div class="sec">Where you're going</div>
    ${stopCards}
    <div class="sec">Covering District ${d}</div>
    <p class="px-4 -mt-1 mb-2 text-[11px] text-blue-100/80 leading-snug">${mine.parties.length} part${mine.parties.length === 1 ? "y" : "ies"}${mine.units.length ? ` · ${mine.units.length} unit${mine.units.length === 1 ? "" : "s"}${others.length ? `: ${others.map(x => `${x}${String(UNITS.get(x).station) !== d ? ` (Stn ${UNITS.get(x).station})` : ""}`).join(", ")}` : ""}` : ""}${mine.open ? ` · <span class="text-red-300 font-bold">${mine.open} still open</span>` : ""}</p>
    ${coveringList}
    <div class="sec">Citywide coverage</div>
    <p class="px-4 -mt-1 mb-2 text-[11px] text-blue-100/80 leading-snug">Parties aren't spread evenly. Districts with more parties than home units get help from other stations.</p>
    <div class="px-3">${coverageTable(stats, d)}</div>
    <div class="px-3 mt-4"><button class="w-full bg-yellow text-navy font-black py-3 rounded-xl text-[11px] uppercase tracking-widest" data-full-map>See full map</button></div>`;
}

function renderCoverage() {
  const pane = $("coverage-pane");
  if (!isCommand()) { pane.innerHTML = ""; return; }
  const stats = districtStats();
  const open = stats.filter(s => s.open);
  const outside = S.parties.filter(p => !p.fireDistrict);
  pane.innerHTML = `
    <p class="px-4 pt-3 text-[11px] text-blue-100/80 leading-snug">Where coverage is thin. Bars turn yellow where a district has more parties than units at its station.</p>
    <div class="px-3 mt-3">${coverageTable(stats)}</div>
    <div class="sec">Still open</div>
    ${open.length ? open.map(s => s.parties.filter(p => !fdUnits(p).length).map(p => `<button class="mini-row" data-party="${esc(p.id)}">
        <span class="time-tag text-white"><i style="background:${timeColor(p.start)}"></i>${fmtTime(p.start)}</span>
        <span class="flex-1 min-w-0 truncate">${esc(p.name)}</span><span class="text-[10px] font-black text-blue-100/70">D${s.d}</span></button>`).join("")).join("")
      : `<p class="px-4 text-[12px] text-green-300 font-bold">Every party has a fire unit.</p>`}
    ${outside.length ? `<p class="px-4 mt-3 text-[11px] text-yellow">${outside.length} part${outside.length === 1 ? "y is" : "ies are"} outside DFD districts or unpinned: ${outside.map(p => esc(p.name)).join(", ")}.</p>` : ""}`;
}

function wireMine() {
  const onClick = e => {
    if (e.target.closest("a")) return; // directions links
    const pick = e.target.closest("[data-pick-unit]");
    if (pick) {
      S.myUnit = pick.dataset.pickUnit;
      try { localStorage.setItem(MY_UNIT_KEY, S.myUnit); } catch { /* storage blocked: kept for this visit */ }
      render();
      const pts = stopsFor(S.myUnit).filter(p => p.lat != null).map(p => [p.lat, p.lng]);
      if (pts.length) S.map.flyToBounds(pts, { padding: [80, 80], maxZoom: 14, duration: 0.6 });
      return;
    }
    if (e.target.closest("[data-change-unit]")) {
      S.myUnit = null;
      try { localStorage.removeItem(MY_UNIT_KEY); } catch { /* ignore */ }
      return render();
    }
    if (e.target.closest("[data-full-map]")) {
      closeSidebar();
      selectParty(null);
      const all = S.parties.filter(p => p.lat != null).map(p => [p.lat, p.lng]);
      if (all.length) S.map.flyToBounds(all, { padding: [60, 60], duration: 0.6 });
      return;
    }
    const row = e.target.closest("[data-party]");
    if (row) selectParty(row.dataset.party, { fly: true });
  };
  $("mine-pane").addEventListener("click", onClick);
  $("coverage-pane").addEventListener("click", onClick);
  $("mine-pane").addEventListener("keydown", e => {
    const card = e.target.closest(".stop-card");
    if (card && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); selectParty(card.dataset.party, { fly: true }); }
  });
}

// ------------------------------------------------------------- finalize, lock, notify

function fmtWhen(ts) {
  const d = ts?.toDate ? ts.toDate() : new Date(ts);
  return isNaN(d) ? "" : d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}

function applyLock() {
  const cmd = isCommand();
  const locked = Boolean(S.event.finalized);
  $("locked-banner").classList.toggle("hidden", !(cmd && locked));
  $("locked-banner").classList.toggle("flex", cmd && locked);
  if (locked) $("locked-text").textContent = `Map locked${S.event.finalizedBy ? ` by ${S.event.finalizedBy}` : ""}${S.event.finalizedAt ? `, ${fmtWhen(S.event.finalizedAt)}` : ""}. Assignments are final.`;
  $("finalize-label").textContent = locked ? "Finalized" : "Finalize";
  $("finalize-btn").classList.toggle("bg-yellow", !locked);
  $("finalize-btn").classList.toggle("bg-green-100", locked);
  $("import-btn").classList.toggle("hidden", !canEdit());
  $("import-btn").classList.toggle("flex", canEdit());
  $("sidebar-hint").innerHTML = canEdit()
    ? "<b class='text-white'>Drag a unit onto a party</b>, or tap a unit and then tap parties. A unit can cover several parties. When everyone is assigned, tap <b class='text-yellow'>Finalize</b>."
    : cmd ? "Map is locked. Tap <b class='text-white'>Unlock to edit</b> above to make changes."
    : "Tap a unit to see its stops. Tap a party for details and directions.";
}

// Problems worth a second look before locking. key is stable so an accepted issue stays accepted.
function findIssues() {
  const issues = [];
  for (const p of S.parties) {
    if (!fdUnits(p).length) issues.push({ key: `uncovered:${p.id}`, level: "error", party: p.id, text: `<b>${esc(p.name)}</b> (${fmtTime(p.start)}) has no fire unit.` });
    if (p.lat == null) issues.push({ key: `nopin:${p.id}`, level: "warn", party: p.id, text: `<b>${esc(p.name)}</b> has no map pin, so crews can't get directions.` });
    else if (!p.fireDistrict) issues.push({ key: `outside:${p.id}`, level: "warn", party: p.id, text: `<b>${esc(p.name)}</b> is pinned outside DFD fire districts. Check the location.` });
    else if (p.pinApprox && !p.pinMoved) issues.push({ key: `approx:${p.id}`, level: "warn", party: p.id, text: `<b>${esc(p.name)}</b> has an approximate pin from its street address. Confirm it.` });
  }
  for (const [u] of UNITS) {
    const byStart = new Map();
    for (const p of stopsFor(u)) byStart.set(p.start, [...(byStart.get(p.start) || []), p]);
    for (const [start, ps] of byStart) if (ps.length > 1) {
      issues.push({ key: `clash:${u}:${start}`, level: "warn", party: ps[0].id, text: `<b>${u}</b> is at ${ps.length} parties starting at ${fmtTime(start)}: ${ps.map(p => esc(p.name)).join(", ")}.` });
    }
  }
  return issues;
}

function openFinalize() {
  if (S.event.finalized) return openNotify();
  if (!S.parties.length) return toast("No parties loaded yet. Import the spreadsheet first.", true);
  const issues = findIssues();
  const accepted = new Set();
  const covered = S.parties.filter(p => fdUnits(p).length).length;
  const unitsOut = new Set(S.parties.flatMap(fdUnits)).size;
  $("finalize-summary").innerHTML = `${covered} of ${S.parties.length} parties covered by ${unitsOut} unit${unitsOut === 1 ? "" : "s"}. ${issues.length ? `${issues.length} item${issues.length === 1 ? "" : "s"} to fix or accept.` : "Everything checks out."}`;
  const list = $("finalize-issues");
  const draw = () => {
    list.innerHTML = issues.length ? issues.map(it => `<li class="py-3 flex items-start gap-3">
        <span class="mt-0.5 w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-black ${it.level === "error" ? "bg-red text-white" : "bg-amber-100 text-amber-700"}">${it.level === "error" ? "!" : "?"}</span>
        <span class="flex-1 text-[13px] leading-snug ${accepted.has(it.key) ? "text-slate-400 line-through" : "text-navy"}">${it.text}</span>
        <span class="flex gap-1.5 shrink-0">
          <button class="text-[10px] font-black uppercase tracking-widest px-2.5 py-1.5 rounded-md bg-slate-100 hover:bg-slate-200" data-fix="${esc(it.party)}">Fix</button>
          <button class="text-[10px] font-black uppercase tracking-widest px-2.5 py-1.5 rounded-md ${accepted.has(it.key) ? "bg-navy text-white" : "border border-slate-300 hover:border-navy"}" data-accept="${esc(it.key)}">${accepted.has(it.key) ? "Accepted" : "Accept"}</button>
        </span></li>`).join("")
      : `<li class="py-4 flex items-center gap-3 text-sm font-bold text-green-700"><span class="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center">✓</span>All parties are covered and every pin checks out.</li>`;
    const ready = issues.every(it => accepted.has(it.key));
    $("finalize-confirm").disabled = !ready;
    $("finalize-confirm").title = ready ? "" : "Fix or accept each item first";
  };
  list.onclick = e => {
    const fix = e.target.closest("[data-fix]");
    if (fix) { $("finalize-dialog").close(); selectParty(fix.dataset.fix, { fly: true }); return; }
    const acc = e.target.closest("[data-accept]");
    if (acc) { accepted.has(acc.dataset.accept) ? accepted.delete(acc.dataset.accept) : accepted.add(acc.dataset.accept); draw(); }
  };
  $("finalize-confirm").onclick = async () => {
    $("finalize-confirm").disabled = true;
    try {
      await S.store.setFinalized(true, issues.filter(it => accepted.has(it.key)).map(it => it.key));
      $("finalize-dialog").close();
      toast("Map finalized and locked");
      openNotify();
    } catch (e) { fail(e); draw(); }
  };
  draw();
  $("finalize-dialog").showModal();
}

function eventDateText() {
  const d = new Date(`${EVENT.date}T12:00:00`);
  return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

function notifyMessage() {
  const url = location.origin + location.pathname;
  return {
    subject: `${EVENT.name}: unit assignments are ready`,
    body: `All,

National Night Out is ${eventDateText()}. Unit assignments are posted on the DFD National Night Out map:

${url}

FIRST TIME? SET UP YOUR ACCOUNT EARLY
- Open the link and tap "Create Account". Use your @cityofdenton.com email.
- The verification email comes from noreply@dfd-national-night-out.firebaseapp.com. It can take up to 15 minutes and may land in Junk, so do this well before your first party.
- If the verification link says it expired or was already used, city email security opened it first. You're verified: just sign in.

HOW TO USE THE MAP
1. Sign in and pick your unit (E6, M3, T1...). Your phone remembers it.
2. "Where you're going" lists your stops in order with start times, plus Google Maps and Apple Maps buttons for directions.
3. Tap any party pin to see the address, time, notes and who's attending. Pinch or use + / - to zoom.
4. A yellow "OUT" tag means a unit is helping outside its home district. Parties aren't spread evenly across the city, so some districts need extra help.
5. The Mayor icon means the Mayor may stop by that party. Keep in mind the Mayor may move around to any or all of the parties.
6. For a quick walkthrough, tap ? (on a phone: the ... menu, then Walkthrough).

Questions: contact your Battalion Chief.

Thank you,
`,
  };
}

function openNotify() {
  const m = notifyMessage();
  $("notify-subject").value = m.subject;
  $("notify-body").value = m.body;
  $("notify-msg").className = "hidden";
  $("notify-dialog").showModal();
}

function wireFinalize() {
  $("finalize-btn").addEventListener("click", openFinalize);
  $("locked-notify").addEventListener("click", openNotify);
  $("locked-unlock").addEventListener("click", async () => {
    if (!confirm("Unlock the map for changes? Crews will see changes as you make them. Finalize again when you're done.")) return;
    try { await S.store.setFinalized(false); toast("Map unlocked for editing"); } catch (e) { fail(e); }
  });
  $("notify-copy").addEventListener("click", async () => {
    const text = `${$("notify-subject").value}\n\n${$("notify-body").value}`;
    try { await navigator.clipboard.writeText(text); }
    catch { $("notify-body").select(); document.execCommand("copy"); }
    const el = $("notify-msg");
    el.textContent = "Copied. Paste it into an email to the department.";
    el.className = "mt-2 text-xs font-bold text-green-700";
  });
  $("notify-email").addEventListener("click", () => {
    const href = `mailto:?subject=${encodeURIComponent($("notify-subject").value)}&body=${encodeURIComponent($("notify-body").value)}`;
    location.href = href;
  });
}

// ------------------------------------------------------------- walkthrough

const tourRole = () => (isCommand() ? "command" : "crew");
let tourChecked = null;
function maybeStartTour() {
  if (tourChecked === tourRole()) return;
  tourChecked = tourRole();
  if (params.has("tour") || !seenTour(tourRole())) setTimeout(startTour, 600);
}

const first = sel => document.querySelector(sel);
const visible = el => el && el.getBoundingClientRect().width > 0 ? el : null;
const samplePin = () => visible(first(".pm:not(.dim) .pm-pin"));
const sampleChipOnMap = () => visible(first(".pm-units .chip[data-unit]"));
const showSidebar = tab => () => { setTab(tab); if (isMobile()) openSidebar(); };
const hideSidebar = () => { if (isMobile()) closeSidebar(); };
function openSampleParty() {
  const p = S.parties.find(q => fdUnits(q).length) || S.parties[0];
  if (p) selectParty(p.id, { fly: true });
}

function commandSteps() {
  const steps = [
    { title: "Welcome to NNO Command", body: "<p>This is where Battalion Chiefs and the Assistant Chief put units on National Night Out parties. Crews see your assignments live on their phones.</p><p class='mt-2'>This takes about a minute. You can replay it anytime with the <b>?</b> button (on a phone: <b>⋯</b> → Walkthrough).</p>" },
    { title: "The roster", target: () => visible($("units-pane")), before: showSidebar("units"),
      body: "<p>Every station's assignable units. The number is the station and its fire district: <b>M5</b> is home in District 5.</p><p class='mt-2'>The count on the right is how many parties that unit covers.</p>" },
    { title: "Drag a unit onto a party", target: () => visible(first("#units-pane .chip.draggable")), before: showSidebar("units"),
      body: "<p>Point at a unit until the cursor becomes an <b>open hand</b>, then drag it onto a party pin and let go.</p><p class='mt-2'>A unit can cover several parties through the evening.</p>" },
    { title: "Or tap, then tap", target: () => visible(first("#units-pane .unit-row")), before: showSidebar("units"),
      body: "<p>Prefer tapping (easier on a phone)? Tap a unit, and every party lights up with a <b>yellow ring</b>. Tap the parties it should cover, then tap <b>Done</b>.</p>" },
    { title: "Party pins", target: samplePin, before: hideSidebar,
      body: "<p>Each pin is a party. Its color and number are the <b>start time</b>. A pulsing <b class='text-red'>red ring</b> means no fire unit yet.</p><p class='mt-2'>Chips beside a pin show who's going: fire units, <b>PD</b> where police were requested, and the <b>Mayor</b>.</p>" },
    { title: "Move or remove a unit", target: () => sampleChipOnMap() || samplePin(), before: hideSidebar,
      body: "<p>Grab a unit chip on the map and drop it on <b>another party</b> to move it.</p><p class='mt-2'>Drop it on the <b>roster</b>, or the red <b>Drop here to unassign</b> target at the bottom, to remove it.</p>" },
    { title: "Out of district", target: () => visible(first(".pm-units .chip.out")) || sampleChipOnMap() || samplePin(), before: hideSidebar,
      body: "<p>A <b class='bg-yellow px-1 rounded'>yellow chip marked OUT</b> is a unit working outside its home district. Crews see why on their phones.</p>" },
    { title: "The party card", target: () => visible($("detail")), before: openSampleParty,
      body: "<p>Tap any party to open its card:</p><ul class='tour-list'><li>Address, notes, time and expected attendance</li><li><b>Google Maps</b> / <b>Apple Maps</b> directions</li><li><b>Add a unit</b> from the list, or remove one with <b>×</b></li><li>Switch the <b>Mayor</b> on or off</li><li><b>Move pin</b> if a location is wrong</li></ul>" },
    { title: "Coverage", target: () => visible($("coverage-pane")), before: () => { selectParty(null); showSidebar("coverage")(); },
      body: "<p>Parties per district against the units at each station. <b class='text-amber-600'>Yellow bars</b> are districts with more parties than home units (usually Six). <b>Still open</b> lists parties with no unit yet.</p>" },
    { title: "Next year's NNO: import the new sheet", target: () => visible($("import-btn")) || visible($("more-btn")), before: hideSidebar,
      body: "<p>Each year the <b>Community Risk Reduction Officer</b> sends the party spreadsheet. Import it here and tick <b>New year: replace all parties</b> to clear last year's parties and assignments.</p><p class='mt-2'>If an <b>updated</b> sheet comes in before the event, import it without that box: assignments, the Mayor and moved pins are kept. Host names are always skipped.</p>" },
  ];
  if (S.role === "owner" && !DEMO) steps.push({ title: "Who can assign", target: () => visible($("access-btn")) || visible($("more-btn")),
    body: "<p>Only you see <b>Access</b>. Add a BC or AC by city email to give them Command. Everyone else who signs up gets the read-only crew view.</p>" });
  steps.push({ title: "Last step: Finalize", target: () => visible($("finalize-btn")), before: hideSidebar,
    body: "<p>When everyone is assigned, tap <b>Finalize</b>. It runs a final check (uncovered parties, pin problems, a unit booked twice at the same time). <b>Fix</b> each item or <b>Accept</b> it, for example a party that canceled.</p><p class='mt-2'>Finalizing <b>locks the map</b> and gives you a ready-made email for the department, with the link and instructions. Use <b>Unlock to edit</b> for last-minute changes.</p>" });
  steps.push({ title: "You're set", body: "<p>Changes save instantly and show up for everyone. Tap <b>?</b> anytime to see this again.</p>" });
  return steps;
}

function crewSteps() {
  return [
    { title: "Welcome to the NNO map", body: "<p>This shows where every Denton Fire unit is going for National Night Out, and when.</p><p class='mt-2'>About 30 seconds. Replay it anytime with the <b>?</b> button (on a phone: <b>⋯</b> → Walkthrough).</p>" },
    { title: "My Unit", target: () => visible($("mine-pane")), before: showSidebar("mine"),
      body: "<p>Pick the unit you're on tonight (this phone remembers it). You'll see <b>where you're going and when</b>, with Google or Apple Maps directions for each stop.</p>" },
    { title: "Why out of district?", target: () => visible($("mine-pane")), before: showSidebar("mine"),
      body: "<p>Parties aren't spread evenly. Some districts (often Six) have far more parties than units, and some have none. Further down you'll see <b>who's covering your district</b> and a <b>citywide table</b> showing where help is needed.</p>" },
    { title: "The map", target: samplePin, before: hideSidebar,
      body: "<p>Each pin is a party, colored by <b>start time</b>. Chips show who's going. A <b class='bg-yellow px-1 rounded'>yellow OUT</b> chip is a unit helping outside its home district.</p>" },
    { title: "Party details", target: () => visible($("detail")), before: openSampleParty,
      body: "<p>Tap any party for its address, time, notes and who's attending, plus <b>Google Maps</b> and <b>Apple Maps</b> buttons for directions.</p>" },
    { title: "You're set", before: () => { selectParty(null); showSidebar("mine")(); },
      body: "<p>Assignments update live as the chiefs make them. Tap <b>?</b> anytime to see this again.</p>" },
  ];
}

function startTour() {
  if (!S.user) return;
  disarm();
  S.selectedUnit = null;
  const role = tourRole();
  runTour(role, role === "command" ? commandSteps() : crewSteps(), {
    onEnd: () => { selectParty(null); setTab(role === "command" ? "units" : "mine"); if (isMobile()) (role === "command" ? closeSidebar() : openSidebar()); },
  });
}

// ------------------------------------------------------------- selection

function selectParty(id, { fly = false } = {}) {
  if (S.movingPin && S.movingPin.id !== id) cancelMovePin();
  S.selectedParty = id;
  if (id && fly) {
    const p = S.byId.get(id);
    if (p?.lat != null) S.map.flyTo([p.lat, p.lng], Math.max(S.map.getZoom(), 14), { duration: 0.6 });
  }
  if (id && isMobile()) closeSidebar();
  render();
}

function selectUnit(id) {
  S.selectedUnit = S.selectedUnit === id ? null : id;
  if (canEdit()) S.selectedUnit ? arm(S.selectedUnit) : disarm();
  if (S.selectedUnit) {
    const pts = stopsFor(S.selectedUnit).filter(p => p.lat != null).map(p => [p.lat, p.lng]);
    if (pts.length === 1) S.map.flyTo(pts[0], Math.max(S.map.getZoom(), 13), { duration: 0.6 });
    else if (pts.length > 1) S.map.flyToBounds(pts, { padding: [80, 80], maxZoom: 14, duration: 0.6 });
    if (isMobile() && (isCommand() || pts.length)) closeSidebar();
  }
  render();
}

function arm(unitId) {
  S.armedUnit = unitId;
  $("arm-text").innerHTML = `Tap a highlighted party to add <b class="text-yellow">${unitId}</b>`;
  $("arm-banner").classList.remove("hidden");
}
function disarm() {
  S.armedUnit = null;
  $("arm-banner").classList.add("hidden");
}

function onPartyTap(id) {
  if (S.armedUnit && canEdit()) return assign(id, S.armedUnit);
  selectParty(S.selectedParty === id ? null : id);
}

async function assign(partyId, unitId) {
  const p = S.byId.get(partyId);
  if (!p) return;
  if ((p.units || []).includes(unitId)) return toast(`${unitId} is already at ${p.name}`);
  try {
    await S.store.assignUnit(partyId, unitId);
    toast(`${unitId} → ${p.name}${isOut(unitId, p) ? " (out of district)" : ""}`);
  } catch (e) { fail(e); }
}

// ------------------------------------------------------------- pin moving

function startMovePin(id) {
  const m = S.markers.get(id);
  const p = S.byId.get(id);
  if (!p) return;
  if (!m) {
    // No pin yet: drop one at the map center to drag from.
    const c = S.map.getCenter();
    S.movingPin = { id, lat: c.lat, lng: c.lng, fd: fireDistrictAt(c.lat, c.lng), temp: L.marker(c, { draggable: true }).addTo(S.map) };
    S.movingPin.temp.on("dragend", () => onPinDragged(S.movingPin.temp));
  } else {
    S.movingPin = { id, lat: p.lat, lng: p.lng };
    m.dragging.enable();
  }
  toast("Drag the pin, then tap Save pin");
  renderDetail();
}
function onPinDragged(m) {
  if (!S.movingPin) return;
  const { lat, lng } = m.getLatLng();
  Object.assign(S.movingPin, { lat: +lat.toFixed(6), lng: +lng.toFixed(6), fd: fireDistrictAt(lat, lng) });
  renderDetail();
}
function cancelMovePin() {
  if (!S.movingPin) return;
  const { id, temp } = S.movingPin;
  temp?.remove();
  const m = S.markers.get(id);
  m?.dragging?.disable();
  const p = S.byId.get(id);
  if (m && p) m.setLatLng([p.lat, p.lng]);
  S.movingPin = null;
}
async function saveMovePin() {
  const { id, lat, lng, temp } = S.movingPin;
  const fd = fireDistrictAt(lat, lng);
  temp?.remove();
  S.markers.get(id)?.dragging?.disable();
  S.movingPin = null;
  try { await S.store.movePin(id, lat, lng, fd); toast(fd ? `Pin saved · Fire District ${fd}` : "Pin saved · outside DFD districts"); }
  catch (e) { fail(e); }
}

// ------------------------------------------------------------- drag and drop (mouse + touch)

function wireDrag() {
  let drag = null;
  let hot = null;
  let swallowClick = false;
  const ghost = $("drag-ghost");
  const zone = $("unassign-zone");

  const setHot = el => {
    if (hot === el) return;
    hot?.classList.remove("drop-hot");
    hot = el;
    hot?.classList.add("drop-hot");
  };
  const inMarker = el => el.closest(".leaflet-marker-icon");

  // Capture phase, so a drag that starts on a chip sitting on the map never reaches Leaflet
  // (which would pan the map instead).
  document.addEventListener("pointerdown", e => {
    const chip = e.target.closest(".chip.draggable[data-unit]");
    if (!chip || !canEdit() || e.button > 0) return;
    if (inMarker(chip)) e.stopPropagation();
    drag = { unit: chip.dataset.unit, from: chip.dataset.from || null, chip, x: e.clientX, y: e.clientY, active: false, id: e.pointerId };
  }, true);
  for (const type of ["mousedown", "touchstart"]) {
    document.addEventListener(type, e => {
      const chip = e.target.closest?.(".chip.draggable[data-unit]");
      if (chip && canEdit() && inMarker(chip)) e.stopPropagation();
    }, { capture: true, passive: true });
  }
  // A finished drag must not also count as a click on whatever it was dropped near.
  document.addEventListener("click", e => {
    if (swallowClick) { e.stopPropagation(); e.preventDefault(); swallowClick = false; }
  }, true);

  document.addEventListener("pointermove", e => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
      drag.active = true;
      drag.chip.classList.add("dragging-src");
      ghost.innerHTML = chipHTML(drag.unit);
      ghost.classList.remove("hidden");
      S.map.dragging.disable();
      S.selectedUnit = drag.unit;
      renderMarkers();
      if (drag.from) zone.classList.remove("hidden");
      if (isMobile() && !drag.from) closeSidebar();
    }
    e.preventDefault();
    ghost.style.left = `${e.clientX - 30}px`;
    ghost.style.top = `${e.clientY - 34}px`;
    ghost.style.display = "none"; // look underneath the ghost
    const under = document.elementFromPoint(e.clientX, e.clientY);
    ghost.style.display = "";
    const party = under?.closest(".pm[data-party], .party-row[data-party]");
    const unassign = drag.from && (under?.closest("#unassign-zone") || (!party && under?.closest("#sidebar")));
    setHot(party || (unassign ? (under.closest("#unassign-zone") || $("sidebar")) : null));
    edgePan(e.clientX, e.clientY);
  }, { passive: false });

  const end = async e => {
    if (!drag || (e.pointerId !== undefined && e.pointerId !== drag.id)) return;
    const d = drag;
    drag = null;
    stopEdgePan();
    if (!d.active) {
      if (!d.from) selectUnit(d.unit); // tap on a roster chip; a tap on a map chip opens its party
      return;
    }
    swallowClick = true;
    setTimeout(() => (swallowClick = false), 400);
    d.chip.classList.remove("dragging-src");
    ghost.classList.add("hidden");
    zone.classList.add("hidden");
    S.map.dragging.enable();
    const dropped = hot;
    setHot(null);
    S.selectedUnit = null;
    render();
    if (e.type !== "pointerup" || !dropped) return;
    const target = dropped.dataset.party;
    try {
      if (!target) {
        await S.store.unassignUnit(d.from, d.unit);
        toast(`${d.unit} removed from ${S.byId.get(d.from)?.name || "party"}`);
      } else if (d.from && target !== d.from) {
        const to = S.byId.get(target);
        if ((to?.units || []).includes(d.unit)) {
          await S.store.unassignUnit(d.from, d.unit);
          toast(`${d.unit} was already at ${to.name}; removed the duplicate`);
        } else {
          await S.store.moveUnit(d.from, target, d.unit);
          toast(`${d.unit} moved to ${to?.name}${to && isOut(d.unit, to) ? " (out of district)" : ""}`);
        }
      } else if (!d.from) {
        assign(target, d.unit);
      }
    } catch (err) { fail(err); }
  };
  document.addEventListener("pointerup", end);
  document.addEventListener("pointercancel", end);

  // Keep scrolling the page from stealing touch drags that start on a chip.
  document.addEventListener("touchmove", e => { if (drag?.active) e.preventDefault(); }, { passive: false });
}

let panRAF = null, panVec = [0, 0];
function edgePan(x, y) {
  const r = $("map").getBoundingClientRect();
  const edge = 48, speed = 12;
  panVec = [x < r.left + edge ? -speed : x > r.right - edge ? speed : 0, y < r.top + edge ? -speed : y > r.bottom - edge ? speed : 0];
  if (x < r.left || x > r.right || y < r.top || y > r.bottom) panVec = [0, 0];
  if (!panRAF && (panVec[0] || panVec[1])) {
    const step = () => {
      if (!panVec[0] && !panVec[1]) { panRAF = null; return; }
      S.map.panBy(panVec, { animate: false });
      panRAF = requestAnimationFrame(step);
    };
    panRAF = requestAnimationFrame(step);
  }
}
function stopEdgePan() { panVec = [0, 0]; }

// ------------------------------------------------------------- sidebar, tabs, events

function openSidebar() { $("sidebar").classList.add("open"); $("sidebar-toggle").setAttribute("aria-expanded", "true"); }
function closeSidebar() { $("sidebar").classList.remove("open"); $("sidebar-toggle").setAttribute("aria-expanded", "false"); }

const TABS = ["mine", "units", "parties", "coverage"];
function setTab(tab) {
  S.tab = tab;
  for (const t of TABS) {
    $(`tab-${t}`).setAttribute("aria-selected", String(t === tab));
    $(`${t}-pane`).classList.toggle("hidden", t !== tab);
  }
  $("sidebar-hint").classList.toggle("hidden", tab !== "units" && tab !== "parties");
}

function wireUI() {
  $("sidebar-toggle").addEventListener("click", () => ($("sidebar").classList.contains("open") ? closeSidebar() : openSidebar()));
  $("sidebar-close").addEventListener("click", closeSidebar);
  for (const t of TABS) $(`tab-${t}`).addEventListener("click", () => setTab(t));
  setTab("units");
  wireMine();

  $("units-pane").addEventListener("click", e => {
    if (e.target.closest(".chip.draggable")) return; // handled by the drag/tap logic
    const row = e.target.closest("[data-unit-row]");
    if (row) selectUnit(row.dataset.unitRow);
  });
  $("units-pane").addEventListener("keydown", e => {
    const row = e.target.closest("[data-unit-row]");
    if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); selectUnit(row.dataset.unitRow); }
  });
  $("parties-pane").addEventListener("click", e => {
    const row = e.target.closest(".party-row");
    if (!row) return;
    if (S.armedUnit && canEdit()) return assign(row.dataset.party, S.armedUnit);
    selectParty(row.dataset.party, { fly: true });
  });

  $("time-filter").addEventListener("click", e => {
    const b = e.target.closest("[data-tf]");
    if (b) { S.timeFilter = b.dataset.tf; render(); }
  });

  $("arm-done").addEventListener("click", () => { disarm(); S.selectedUnit = null; render(); });
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if (S.movingPin) { cancelMovePin(); renderDetail(); return; }
    if (S.armedUnit || S.selectedUnit) { disarm(); S.selectedUnit = null; render(); return; }
    if (S.selectedParty) selectParty(null);
  });

  $("detail").addEventListener("click", async e => {
    const p = S.byId.get(S.selectedParty);
    if (!p) return;
    const t = e.target.closest("button, input");
    if (!t) return;
    if (t.id === "detail-close") return selectParty(null);
    if (t.dataset.unassign) return S.store.unassignUnit(p.id, t.dataset.unassign).then(() => toast(`${t.dataset.unassign} removed from ${p.name}`)).catch(fail);
    if (t.id === "add-unit-btn") { const u = $("add-unit").value; if (u) assign(p.id, u); return; }
    if (t.id === "pin-move") return startMovePin(p.id);
    if (t.id === "pin-cancel") { cancelMovePin(); return renderDetail(); }
    if (t.id === "pin-save") return saveMovePin();
    if (t.id === "party-remove") {
      if (confirm(`Remove ${p.name} from the map? Its unit assignments are removed too.`)) S.store.removeParty(p.id).then(() => toast("Party removed")).catch(fail);
    }
  });
  $("detail").addEventListener("change", e => {
    if (e.target.id === "mayor-toggle") S.store.setMayor(S.selectedParty, e.target.checked).catch(fail);
  });

  document.querySelectorAll("dialog .dialog-close").forEach(b => b.addEventListener("click", () => b.closest("dialog").close()));
  document.querySelectorAll("dialog").forEach(d => d.addEventListener("click", e => { if (e.target === d) d.close(); }));

  $("help-btn").addEventListener("click", startTour);

  const MORE = [["import-btn", "Import spreadsheet"], ["access-btn", "Command access"], ["help-btn", "Walkthrough"], ["logout-btn", "Sign out"]];
  const closeMore = () => { $("more-menu").classList.add("hidden"); $("more-btn").setAttribute("aria-expanded", "false"); };
  $("more-btn").addEventListener("click", e => {
    e.stopPropagation();
    const menu = $("more-menu");
    if (!menu.classList.contains("hidden")) return closeMore();
    menu.innerHTML = MORE.filter(([id]) => !$(id).classList.contains("hidden"))
      .map(([id, label]) => `<button role="menuitem" data-proxy="${id}" class="w-full text-left px-4 py-3 text-[13px] font-bold text-navy hover:bg-slate-50${id === "logout-btn" ? " text-red border-t border-slate-100 mt-1" : ""}">${label}</button>`).join("");
    menu.classList.remove("hidden");
    $("more-btn").setAttribute("aria-expanded", "true");
  });
  $("more-menu").addEventListener("click", e => {
    const b = e.target.closest("[data-proxy]");
    if (!b) return;
    closeMore();
    $(b.dataset.proxy).click();
  });
  document.addEventListener("click", e => { if (!e.target.closest("#more-menu, #more-btn")) closeMore(); });

  $("qr-fab").addEventListener("click", () => {
    const box = $("qr-code");
    box.innerHTML = "";
    const url = location.origin + location.pathname;
    if (window.QRCode) new QRCode(box, { text: url, width: 200, height: 200, colorDark: "#152a40", colorLight: "#ffffff" });
    else box.textContent = url;
    $("qr-dialog").showModal();
  });

  wireImport();
  wireAccess();
  wireFinalize();

  if (DEMO) {
    $("demo-banner").classList.remove("hidden");
    $("demo-banner").classList.add("flex");
    document.querySelectorAll(".demo-role").forEach(b => b.addEventListener("click", () => S.store.setDemoRole(b.dataset.demoRole)));
    $("demo-reset").addEventListener("click", () => { S.store.resetDemo(); toast("Demo reset"); });
  }
}

// ------------------------------------------------------------- import

function wireImport() {
  let pending = null;
  const msg = (text, ok) => { const el = $("import-msg"); el.textContent = text; el.className = `mt-3 text-xs font-bold ${ok ? "text-green-700" : "text-red"}`; };

  $("import-btn").addEventListener("click", () => {
    pending = null;
    $("import-file").value = "";
    $("import-preview").innerHTML = "";
    $("import-msg").className = "hidden";
    $("import-confirm").disabled = true;
    $("import-replace").checked = false;
    $("import-dialog").showModal();
  });

  $("import-file").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    $("import-confirm").disabled = true;
    msg("Reading…", true);
    try {
      await loadDistricts();
      const { parties, skippedColumns } = await parseWorkbook(file);
      if (!parties.length) throw new Error("No parties found in that sheet.");
      await fillMissingPins(parties.filter(p => !S.byId.get(p.id)?.pinMoved), (i, n) => msg(`Looking up ${n === 1 ? "an address" : `address ${i} of ${n}`} with no map link…`, true));
      pending = parties;
      const warn = parties.filter(p => !S.byId.get(p.id)?.pinMoved && (p.lat == null || !p.fireDistrict || p.pinApprox)).length;
      msg(`${parties.length} parties found.${skippedColumns ? " Host names skipped." : ""}${warn ? ` ${warn} need a pin check (marked below).` : ""}`, !warn);
      $("import-preview").innerHTML = `<table class="w-full text-xs"><thead><tr class="text-left text-[10px] uppercase tracking-widest text-slate-400">
          <th class="py-1.5 pr-2">Party</th><th class="pr-2">Time</th><th class="pr-2">Fire</th><th class="pr-2">Council</th><th>Notes</th></tr></thead><tbody>
        ${parties.map(p => {
          const prev = S.byId.get(p.id);
          const issue = p.lat == null ? "No map pin" : !p.fireDistrict ? "Pin outside DFD districts" : p.pinApprox ? "Approximate pin from address: check it" : "";
          const kept = prev?.pinMoved ? "Keeps your moved pin" : "";
          return `<tr class="border-t border-slate-100 align-top"><td class="py-1.5 pr-2 font-bold">${esc(p.name)}${prev ? "" : " <span class='text-[9px] text-green-700'>NEW</span>"}</td>
            <td class="pr-2 tnum whitespace-nowrap">${fmtTime(p.start)}–${fmtTime(p.end)}</td>
            <td class="pr-2">${p.fireDistrict ? `D${esc(p.fireDistrict)}` : "—"}</td><td class="pr-2">${esc(p.council)}</td>
            <td class="${issue && !kept ? "text-red font-bold" : "text-slate-500"}">${esc(kept || issue)}${p.mayor ? " Mayor requested." : ""}</td></tr>`;
        }).join("")}</tbody></table>`;
      $("import-confirm").disabled = false;
    } catch (err) {
      pending = null;
      $("import-preview").innerHTML = "";
      msg(err.message);
    }
  });

  $("import-confirm").addEventListener("click", async () => {
    if (!pending) return;
    $("import-confirm").disabled = true;
    try {
      const replace = $("import-replace").checked;
      if (replace) {
        const gone = S.parties.filter(p => !pending.some(q => q.id === p.id)).length;
        if (!confirm(`Replace all parties for a new year?\n\n${gone} part${gone === 1 ? "y" : "ies"} not in this sheet will be removed, and every unit assignment and Mayor stop will be cleared.`)) {
          $("import-confirm").disabled = false;
          return;
        }
      }
      await S.store.importParties(pending, S.byId, { replace });
      $("import-dialog").close();
      toast(replace ? `New year loaded: ${pending.length} parties, no assignments yet` : `${pending.length} parties imported`);
    } catch (e) { fail(e); $("import-confirm").disabled = false; }
  });
}

// ------------------------------------------------------------- command access (owner)

function wireAccess() {
  const msg = (text, ok) => { const el = $("access-msg"); el.textContent = text; el.className = `mb-3 text-xs font-bold ${ok ? "text-green-700" : "text-red"}`; };
  const load = async () => {
    try {
      const roles = (await S.store.listRoles()).sort((a, b) => a.email.localeCompare(b.email));
      $("access-list").innerHTML = roles.map(r => `<li class="flex items-center justify-between py-2.5 gap-2">
        <span class="text-sm font-semibold truncate">${esc(r.email)}</span>
        <span class="flex items-center gap-2"><span class="tagline">${esc(r.role)}</span>
        ${r.role === "owner" ? "" : `<button class="icon-btn" data-revoke="${esc(r.email)}" aria-label="Remove ${esc(r.email)}"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M6 18L18 6M6 6l12 12"/></svg></button>`}</span></li>`).join("");
    } catch (e) { msg(`Couldn't load: ${e.code || e.message}`); }
  };
  $("access-btn").addEventListener("click", () => { $("access-msg").className = "hidden"; $("access-dialog").showModal(); load(); });
  $("access-form").addEventListener("submit", async e => {
    e.preventDefault();
    const email = $("access-email").value.trim().toLowerCase();
    if (!isCityEmail(email)) return msg(`Use a ${ALLOWED_EMAIL_DOMAIN} address`);
    try { await S.store.setRole(email, "command"); $("access-email").value = ""; msg(`${email} can now assign units. They may need to sign out and back in.`, true); load(); }
    catch (err) { msg(`Couldn't add: ${err.code || err.message}`); }
  });
  $("access-list").addEventListener("click", async e => {
    const b = e.target.closest("[data-revoke]");
    if (!b || !confirm(`Remove Command access for ${b.dataset.revoke}?`)) return;
    try { await S.store.removeRole(b.dataset.revoke); load(); } catch (err) { msg(`Couldn't remove: ${err.code || err.message}`); }
  });
}

// ------------------------------------------------------------- boot

async function boot() {
  wireAuth();
  wireUI();
  wireDrag();
  if (DEMO) {
    S.store = demoStore(params.get("role") === "crew" ? "crew" : "command");
  } else if (!firebaseConfig.projectId && !params.has("emulator")) {
    $("secure-text").textContent = "Backend not configured";
    loginMsg("This copy isn't connected to its backend yet. Add ?demo=1 to the address to try the demo.");
    return;
  } else {
    try { S.store = await firebaseStore(); }
    catch (e) { console.error(e); loginMsg("Couldn't reach the sign-in service. Check your connection and reload."); return; }
  }
  $("secure-light").className = "w-2 h-2 rounded-full bg-green-500";
  $("secure-text").textContent = "Secure sign-in";
  S.store.onAuth(handleAuth);
  setInterval(() => { if (S.user && isEventNight()) render(); }, 60_000); // keep "Live now" current
}

boot();
