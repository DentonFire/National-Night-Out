// Reads the Community Risk Reduction Officer's NNO spreadsheet in the browser and turns each row into a party.
// The host-name column is never read into a party: it is matched only so it can be skipped.

import { fireDistrictAt } from "./geo.js";

const SHEETJS = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";

function loadSheetJS() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SHEETJS;
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error("Couldn't load the spreadsheet reader. Check your connection."));
    document.head.appendChild(s);
  });
}

const COLUMNS = {
  name: /neighbo|apartment|hoa/i,
  address: /event location/i,
  notes: /location notes/i,
  council: /council/i,
  start: /start/i,
  end: /end time/i,
  attendance: /attendance/i,
  depts: /departments/i,
  guests: /^other$/i,
};
const SKIP = /host/i; // Party Host Name: never imported

export const slug = s => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// "5:30 p.m." -> "17:30". Returns "" when unreadable.
export function to24h(text) {
  const m = String(text || "").match(/(\d{1,2})(?::(\d{2}))?\s*([ap])?/i);
  if (!m) return "";
  let h = Number(m[1]);
  const min = m[2] || "00";
  const ap = (m[3] || "p").toLowerCase(); // NNO is an evening event: assume p.m. when unmarked
  if (ap === "p" && h < 12) h += 12;
  if (ap === "a" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${min}`;
}

function coordsFromLink(url) {
  if (!url) return null;
  const m = decodeURIComponent(url).match(/(?:query=|q=|@|ll=)(-?\d+\.\d+),\s*(-?\d+\.\d+)/);
  return m ? { lat: Number(Number(m[1]).toFixed(6)), lng: Number(Number(m[2]).toFixed(6)) } : null;
}

// Mentions of the Mayor in "Other", ignoring "Mayor Pro Tem" on its own.
const mentionsMayor = text => /\bmayor\b(?!\s+pro\s+tem)/i.test(text || "");

export async function parseWorkbook(file) {
  const XLSX = await loadSheetJS();
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const range = XLSX.utils.decode_range(ws["!ref"]);
  const cell = (r, c) => ws[XLSX.utils.encode_cell({ r, c })];
  const text = (r, c) => String(cell(r, c)?.w ?? cell(r, c)?.v ?? "").trim();

  // Header row: the first row with an "Event Location" column.
  let headerRow = -1;
  for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 10) && headerRow < 0; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) if (COLUMNS.address.test(text(r, c))) { headerRow = r; break; }
  }
  if (headerRow < 0) throw new Error("Couldn't find the header row. Expected a column named “Event Location”.");

  const col = {};
  let skipped = 0;
  for (let c = range.s.c; c <= range.e.c; c++) {
    const h = text(headerRow, c);
    if (!h) continue;
    if (SKIP.test(h)) { skipped++; continue; }
    for (const [key, re] of Object.entries(COLUMNS)) if (col[key] == null && re.test(h)) { col[key] = c; break; }
  }
  if (col.name == null) throw new Error("Couldn't find the party name column.");

  const parties = [];
  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const name = text(r, col.name);
    if (!name) continue;
    const get = k => (col[k] == null ? "" : text(r, col[k]));
    const pin = coordsFromLink(cell(r, col.address)?.l?.Target);
    const depts = get("depts").split(/\s*,\s*/).filter(Boolean);
    const guests = get("guests");
    parties.push({
      id: slug(name),
      name,
      address: get("address"),
      notes: get("notes"),
      council: get("council"),
      start: to24h(get("start")),
      end: to24h(get("end")),
      attendance: get("attendance"),
      depts,
      guests,
      police: depts.some(d => /police/i.test(d)),
      mayor: mentionsMayor(guests),
      lat: pin?.lat ?? null,
      lng: pin?.lng ?? null,
      fireDistrict: pin ? fireDistrictAt(pin.lat, pin.lng) : null,
      pinMoved: false,
      pinApprox: false,
    });
  }
  return { parties, skippedColumns: skipped };
}

// For rows without a map link: look the address up (OpenStreetMap Nominatim, max 1 request a
// second per its usage policy) and mark the pin approximate so Command checks it.
export async function fillMissingPins(parties, onProgress = () => {}) {
  const missing = parties.filter(p => p.lat == null && p.address);
  for (const [i, p] of missing.entries()) {
    onProgress(i + 1, missing.length);
    try {
      const q = /denton/i.test(p.address) ? p.address : `${p.address}, Denton, TX`;
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(q)}`);
      const [hit] = await res.json();
      if (hit) {
        p.lat = Number(Number(hit.lat).toFixed(6));
        p.lng = Number(Number(hit.lon).toFixed(6));
        p.fireDistrict = fireDistrictAt(p.lat, p.lng);
        p.pinApprox = true;
      }
    } catch { /* leave it unpinned; Command can place it with Move pin */ }
    if (i < missing.length - 1) await new Promise(r => setTimeout(r, 1100));
  }
}
