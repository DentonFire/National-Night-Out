// Data layer. Two interchangeable backends with the same interface:
//   firebaseStore() — Firebase Auth + Firestore (production)
//   demoStore()     — in-browser only, synthetic parties, nothing leaves the device (?demo=1)
//
// Party document (collection "parties", id = slug of the party name):
//   name, address, notes, lat, lng, council, fireDistrict, start "HH:MM", end "HH:MM",
//   attendance, depts[], guests, police, mayor, units[], pinMoved
// Role document (collection "roles", id = lowercase email): { role: "command" | "owner" }

import { firebaseConfig, ALLOWED_EMAIL_DOMAIN } from "./config.js";

const FB = "https://www.gstatic.com/firebasejs/11.6.1";

export const isCityEmail = email => email.trim().toLowerCase().endsWith(ALLOWED_EMAIL_DOMAIN);

export async function firebaseStore() {
  const [{ initializeApp }, A, F] = await Promise.all([
    import(`${FB}/firebase-app.js`),
    import(`${FB}/firebase-auth.js`),
    import(`${FB}/firebase-firestore.js`),
  ]);
  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);
  const partiesCol = F.collection(db, "parties");
  const who = () => auth.currentUser?.email?.toLowerCase() || "unknown";
  const stamp = () => ({ updatedAt: F.serverTimestamp(), updatedBy: who() });

  return {
    mode: "live",

    onAuth(cb) {
      return A.onAuthStateChanged(auth, async user => {
        if (!user) return cb({ user: null });
        if (!user.emailVerified) return cb({ user, unverified: true });
        let role = "crew";
        try {
          const snap = await F.getDoc(F.doc(db, "roles", user.email.toLowerCase()));
          if (snap.exists()) role = snap.data().role;
        } catch (e) { /* no role doc readable: crew */ }
        cb({ user, role });
      });
    },
    async signIn(email, password) {
      await A.setPersistence(auth, A.browserLocalPersistence);
      return A.signInWithEmailAndPassword(auth, email.trim().toLowerCase(), password);
    },
    async signUp(email, password) {
      const cred = await A.createUserWithEmailAndPassword(auth, email.trim().toLowerCase(), password);
      await A.sendEmailVerification(cred.user, { url: location.href.split("?")[0] });
      await A.signOut(auth);
    },
    resetPassword: email =>
      A.sendPasswordResetEmail(auth, email.trim().toLowerCase(), { url: location.href.split("?")[0] }),
    resendVerification: () => A.sendEmailVerification(auth.currentUser, { url: location.href.split("?")[0] }),
    reloadUser: async () => { await auth.currentUser?.reload(); return auth.currentUser?.emailVerified; },
    signOut: () => A.signOut(auth),

    subscribeParties(cb, onError) {
      return F.onSnapshot(partiesCol, snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))), onError);
    },
    assignUnit: (id, unit) => F.updateDoc(F.doc(db, "parties", id), { units: F.arrayUnion(unit), ...stamp() }),
    unassignUnit: (id, unit) => F.updateDoc(F.doc(db, "parties", id), { units: F.arrayRemove(unit), ...stamp() }),
    setMayor: (id, on) => F.updateDoc(F.doc(db, "parties", id), { mayor: on, ...stamp() }),
    movePin: (id, lat, lng, fireDistrict) =>
      F.updateDoc(F.doc(db, "parties", id), { lat, lng, fireDistrict, pinMoved: true, ...stamp() }),
    removeParty: id => F.deleteDoc(F.doc(db, "parties", id)),

    // Upsert from the spreadsheet. Keeps assignments, Mayor flags and hand-moved pins.
    async importParties(list, existing) {
      const batch = F.writeBatch(db);
      for (const p of list) {
        const prev = existing.get(p.id);
        const keepPin = prev?.pinMoved;
        batch.set(F.doc(db, "parties", p.id), {
          ...p,
          ...(keepPin ? { lat: prev.lat, lng: prev.lng, fireDistrict: prev.fireDistrict, pinMoved: true } : {}),
          units: prev?.units || [],
          mayor: Boolean(prev?.mayor || p.mayor),
          ...stamp(),
        });
      }
      await batch.commit();
    },

    listRoles: async () => (await F.getDocs(F.collection(db, "roles"))).docs.map(d => ({ email: d.id, ...d.data() })),
    setRole: (email, role) => F.setDoc(F.doc(db, "roles", email.trim().toLowerCase()), { role, ...stamp() }),
    removeRole: email => F.deleteDoc(F.doc(db, "roles", email)),
  };
}

// ---------------------------------------------------------------- demo

const DEMO_KEY = "nno-demo-v1";

// Synthetic parties at invented spots inside each fire district. Not real events.
const DEMO_PARTIES = [
  ["Maple Commons Block Party", 33.2141, -97.1301, "1", "17:00", "18:00", ["Fire", "Police", "Library"]],
  ["Harvest Lane HOA", 33.2232, -97.0705, "2", "17:30", "19:00", ["Fire", "Police"]],
  ["Juniper Court Cookout", 33.1981, -97.1521, "3", "18:00", "20:00", ["Fire", "Police", "311"]],
  ["North Ridge Neighbors", 33.2841, -97.0951, "4", "18:00", "19:30", ["Fire", "Police"]],
  ["Lantern Hill Apartments", 33.2611, -97.1601, "5", "17:00", "18:30", ["Fire", "Library"]],
  ["Bluebonnet Park Picnic", 33.1625, -97.1198, "6", "17:30", "19:30", ["Fire", "Police", "Library"], true],
  ["Cedar Bend Estates", 33.1559, -97.1101, "6", "18:30", "20:00", ["Fire", "Police"]],
  ["Prairie View Village", 33.1611, -97.2001, "7", "18:30", "19:30", ["Fire", "Police", "Library"]],
  ["Oak Hollow Community", 33.1831, -97.0881, "8", "17:00", "19:00", ["Fire", "Police"]],
  ["Westwind Meadows", 33.2161, -97.1961, "9", "18:00", "20:00", ["Fire"]],
].map(([name, lat, lng, fireDistrict, start, end, depts, mayor]) => ({
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  name, lat, lng, fireDistrict, start, end, depts,
  address: "Sample address, Denton, TX",
  notes: "Synthetic demo party",
  council: String(1 + (Number(fireDistrict) % 4)),
  attendance: "40",
  guests: mayor ? "Mayor" : "",
  police: depts.includes("Police"),
  mayor: Boolean(mayor),
  units: [],
}));

export function demoStore(initialRole = "command") {
  let parties;
  try { parties = JSON.parse(localStorage.getItem(DEMO_KEY)); } catch { parties = null; }
  if (!Array.isArray(parties)) parties = structuredClone(DEMO_PARTIES);
  const listeners = new Set();
  let authCb = null;
  let role = initialRole;
  const save = () => {
    try { localStorage.setItem(DEMO_KEY, JSON.stringify(parties)); } catch { /* storage blocked */ }
    const copy = structuredClone(parties);
    listeners.forEach(cb => cb(copy));
  };
  const edit = (id, fn) => { const p = parties.find(x => x.id === id); if (p) { fn(p); save(); } };
  const user = { email: "demo@cityofdenton.com" };

  return {
    mode: "demo",
    onAuth(cb) { authCb = cb; setTimeout(() => cb({ user, role })); return () => {}; },
    setDemoRole(r) { role = r; authCb?.({ user, role }); },
    async signIn() {}, async signUp() {}, async resetPassword() {}, async resendVerification() {},
    reloadUser: async () => true,
    async signOut() { authCb?.({ user, role }); },
    subscribeParties(cb) { listeners.add(cb); setTimeout(() => cb(structuredClone(parties))); return () => listeners.delete(cb); },
    async assignUnit(id, u) { edit(id, p => { if (!p.units.includes(u)) p.units.push(u); }); },
    async unassignUnit(id, u) { edit(id, p => { p.units = p.units.filter(x => x !== u); }); },
    async setMayor(id, on) { edit(id, p => { p.mayor = on; }); },
    async movePin(id, lat, lng, fd) { edit(id, p => Object.assign(p, { lat, lng, fireDistrict: fd, pinMoved: true })); },
    async removeParty(id) { parties = parties.filter(p => p.id !== id); save(); },
    async importParties(list, existing) {
      for (const p of list) {
        const prev = existing.get(p.id);
        const next = { ...p, units: prev?.units || [], mayor: Boolean(prev?.mayor || p.mayor) };
        if (prev?.pinMoved) Object.assign(next, { lat: prev.lat, lng: prev.lng, fireDistrict: prev.fireDistrict, pinMoved: true });
        const i = parties.findIndex(x => x.id === p.id);
        if (i >= 0) parties[i] = next; else parties.push(next);
      }
      save();
    },
    resetDemo() { parties = structuredClone(DEMO_PARTIES); save(); },
    async listRoles() { return [{ email: user.email, role: "owner" }]; },
    async setRole() {}, async removeRole() {},
  };
}
