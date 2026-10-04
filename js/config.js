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

export const EVENT = {
  name: "National Night Out 2026",
  date: "2026-10-06", // first Tuesday in October (Texas)
};

export const MAP_CENTER = [33.2148, -97.1331];
