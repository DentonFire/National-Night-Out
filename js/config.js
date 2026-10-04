// Public configuration. Firebase web config is not a secret: access is enforced by
// Firestore rules (firestore.rules) and Auth settings, never by hiding these values.

export const firebaseConfig = {
  apiKey: "AIzaSyCyvbIsuNLFW1UliQIh83CKtBEwGMkVcSY",
  authDomain: "dfd-national-night-out.firebaseapp.com",
  projectId: "dfd-national-night-out",
  storageBucket: "dfd-national-night-out.firebasestorage.app",
  messagingSenderId: "556210811085",
  appId: "1:556210811085:web:0a5869373b0bb40995f984",
};

// Only verified accounts on this domain can sign in or read data.
export const ALLOWED_EMAIL_DOMAIN = "@cityofdenton.com";

// Texas holds National Night Out on the first Tuesday in October, so the date follows the calendar:
// this year's, or next year's once this year's has passed.
function nnoDate(year) {
  const d = new Date(year, 9, 1);
  d.setDate(1 + ((2 - d.getDay() + 7) % 7));
  return d;
}
const today = new Date();
today.setHours(0, 0, 0, 0);
const nno = nnoDate(today.getFullYear()) >= today ? nnoDate(today.getFullYear()) : nnoDate(today.getFullYear() + 1);
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const EVENT = {
  name: `National Night Out ${nno.getFullYear()}`,
  date: iso(nno),
};

export const MAP_CENTER = [33.2148, -97.1331];
