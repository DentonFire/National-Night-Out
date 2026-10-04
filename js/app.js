import { firebaseConfig, EVENT, MAP_CENTER, ALLOWED_EMAIL_DOMAIN } from "./config.js";
import { STATIONS, UNITS, TYPE_LABEL } from "./roster.js";
import { vehicleSVG, mayorSVG } from "./icons.js";
import { loadDistricts, fireDistrictAt } from "./geo.js";
import { firebaseStore, demoStore, isCityEmail } from "./store.js";
import { parseWorkbook, fillMissingPins } from "./importer.js";

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
  myUnit: null,
  tabRole: null,
};
const MY_UNIT_KEY = "nno-my-unit";
try { const u = localStorage.getItem(MY_UNIT_KEY); if (UNITS.has(u)) S.myUnit = u; } catch { /* storage blocked */ }
const isCommand = () => S.role === "command" || S.role === "owner";
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

function chipHTML(unitId, { party, draggable, title } = {}) {
  const u = UNITS.get(unitId);
  if (!u) return "";
  const out = party && isOut(unitId, party);
  const mine = !isCommand() && unitId === S.myUnit;
  const t = title || `${TYPE_LABEL[u.type]} ${unitId}, Station ${u.station}${out ? `, out of district (home District ${u.station})` : ""}`;
  return `<span class="chip${out ? " out" : ""}${mine ? " mine" : ""}${draggable ? " draggable" : ""}" data-unit="${unitId}" title="${esc(t)}" aria-label="${esc(t)}">${vehicleSVG(u.type)}${unitId}</span>`;
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
        loginMsg(`Account created. Open the verification link sent to ${email}, then sign in.`, true);
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
  $("verify-cancel").addEventListener("click", () => S.store.signOut());
  $("logout-btn").addEventListener("click", () => { if (DEMO || confirm("Sign out of the NNO map?")) S.store.signOut(); });
}

function setSignUpMode(on) {
  signUpMode = on;
  $("auth-mode-title").textContent = on ? "Create Account" : "National Night Out";
  $("login-btn").textContent = on ? "Register" : "Authenticate";
  $("auth-toggle").innerHTML = on ? "Have an account? <span class='underline'>Sign In</span>" : "Need access? <span class='underline'>Create Account</span>";
  $("password").autocomplete = on ? "new-password" : "current-password";
  $("login-msg").classList.add("hidden");
}

function handleAuth({ user, unverified, role }) {
  clearInterval(verifyTimer);
  $("verify-modal").classList.add("hidden");
  if (!user) {
    S.user = null;
    S.unsubscribe?.();
    S.unsubscribe = null;
    $("app").classList.add("hidden");
    $("app").classList.remove("flex");
    $("login-overlay").style.display = "flex";
    $("secure-light").className = "w-2 h-2 rounded-full bg-yellow-400 animate-pulse";
    $("secure-text").textContent = "Secure sign-in";
    return;
  }
  if (unverified) {
    $("verify-target").textContent = user.email;
    $("verify-modal").classList.remove("hidden");
    verifyTimer = setInterval(async () => {
      if (await S.store.reloadUser()) { clearInterval(verifyTimer); location.reload(); }
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
  const cmd = isCommand();
  $("role-pill").textContent = cmd ? "Command" : "Crew";
  $("role-pill").className = `hidden sm:inline-block text-[9px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full ${cmd ? "bg-navy text-yellow" : "bg-slate-100 text-slate-500"}`;
  $("import-btn").classList.toggle("hidden", !cmd);
  $("import-btn").classList.toggle("flex", cmd);
  $("access-btn").classList.toggle("hidden", S.role !== "owner" || DEMO);
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
  if (!S.unsubscribe) {
    S.unsubscribe = S.store.subscribeParties(parties => {
      S.parties = parties.sort(byTime);
      S.byId = new Map(parties.map(p => [p.id, p]));
      if (S.selectedParty && !S.byId.has(S.selectedParty)) S.selectedParty = null;
      S.lastSync = new Date();
      setStatus(true);
      $("map-loading").classList.add("hidden");
      render();
    }, err => {
      console.error(err);
      setStatus(false, err.code === "permission-denied" ? "No access: ask Command" : "Connection error");
      $("map-loading").classList.add("hidden");
    });
  } else {
    render();
  }
}

function setStatus(ok, text) {
  $("status-dot").className = `w-2 h-2 rounded-full ${ok && navigator.onLine ? "bg-green-500" : ok ? "bg-yellow-400" : "bg-red"}`;
  if (text) return ($("status-text").textContent = text);
  if (!navigator.onLine) return ($("status-text").textContent = "Offline: showing last update");
  const when = S.lastSync ? S.lastSync.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  $("status-text").textContent = DEMO ? "Demo data" : `Live · synced ${when}`;
}
addEventListener("online", () => setStatus(true));
addEventListener("offline", () => setStatus(true));

// ------------------------------------------------------------- map

function initMap() {
  if (S.map) { setTimeout(() => S.map.invalidateSize(), 50); return; }
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
  loadDistricts().then(geo => {
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
  setTimeout(() => S.map.invalidateSize(), 50);
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
  const unitDim = S.selectedUnit && !(p.units || []).includes(S.selectedUnit);
  const cls = ["pm", need && "need", !visible || unitDim ? "dim" : "", S.selectedParty === p.id && "selected", isLive(p) && "live"].filter(Boolean).join(" ");
  const chips = units.map(u => chipHTML(u, { party: p })).join("") + (p.police ? pdChip() : "") + (p.mayor ? mayorChip() : "");
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
  $("stat-parties").textContent = S.parties.length;
  $("stat-units").textContent = out.size;
  $("stat-open").textContent = S.parties.filter(p => fdUnits(p).length === 0).length;
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
  const cmd = isCommand();
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
    pane.innerHTML = `<div class="p-6 text-center text-blue-100/80 text-sm">${isCommand() ? "No parties yet. Use <b class='text-white'>Import</b> to load the spreadsheet from Community Engagement." : "No parties yet. Command will load them before the event."}</div>`;
    return;
  }
  pane.innerHTML = S.parties.map(p => {
    const units = fdUnits(p);
    const chips = units.map(u => chipHTML(u, { party: p })).join("") + (p.police ? pdChip() : "") + (p.mayor ? mayorChip() : "");
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
  const cmd = isCommand();
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
  if (isCommand()) S.selectedUnit ? arm(S.selectedUnit) : disarm();
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
  $("arm-text").innerHTML = `Tap parties to add <b class="text-yellow">${unitId}</b>`;
  $("arm-banner").classList.remove("hidden");
}
function disarm() {
  S.armedUnit = null;
  $("arm-banner").classList.add("hidden");
}

function onPartyTap(id) {
  if (S.armedUnit && isCommand()) return assign(id, S.armedUnit);
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
  const ghost = $("drag-ghost");
  let hot = null;

  const setHot = el => {
    if (hot === el) return;
    hot?.classList.remove("drop-hot");
    hot = el;
    hot?.classList.add("drop-hot");
  };

  document.addEventListener("pointerdown", e => {
    const chip = e.target.closest("#units-pane .chip.draggable");
    if (!chip || !isCommand() || e.button > 0) return;
    drag = { unit: chip.dataset.unit, chip, x: e.clientX, y: e.clientY, active: false, id: e.pointerId };
  });

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
      if (isMobile()) closeSidebar();
    }
    e.preventDefault();
    ghost.style.left = `${e.clientX - 30}px`;
    ghost.style.top = `${e.clientY - 34}px`;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    setHot(under?.closest(".pm[data-party], .party-row[data-party]") || null);
    edgePan(e.clientX, e.clientY);
  }, { passive: false });

  const end = e => {
    if (!drag || (e.pointerId !== undefined && e.pointerId !== drag.id)) return;
    const d = drag;
    drag = null;
    stopEdgePan();
    if (!d.active) {
      // A tap, not a drag: same as tapping the row.
      selectUnit(d.unit);
      return;
    }
    d.chip.classList.remove("dragging-src");
    ghost.classList.add("hidden");
    S.map.dragging.enable();
    const target = hot?.dataset.party;
    setHot(null);
    S.selectedUnit = null;
    if (target && e.type === "pointerup") assign(target, d.unit);
    render();
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
    if (S.armedUnit && isCommand()) return assign(row.dataset.party, S.armedUnit);
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
      await S.store.importParties(pending, S.byId);
      $("import-dialog").close();
      toast(`${pending.length} parties imported`);
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
  } else if (!firebaseConfig.projectId) {
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
