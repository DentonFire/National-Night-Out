const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

function loadStore({ A = {}, F = {}, local = new Map() } = {}) {
  let source = process.env.NNO_SOURCE_REF
    ? execFileSync('git', ['show', `${process.env.NNO_SOURCE_REF}:js/store.js`], { encoding: 'utf8' })
    : fs.readFileSync('js/store.js', 'utf8');
  source = source.replace(/import \{ firebaseConfig, ALLOWED_EMAIL_DOMAIN \} from "\.\/config.js";/,
    'const firebaseConfig = {}; const ALLOWED_EMAIL_DOMAIN = "@cityofdenton.com";');
  source = source.replace(/export /g, '')
    .replace('import(`${FB}/firebase-app.js`)', 'Promise.resolve(APP)')
    .replace('import(`${FB}/firebase-auth.js`)', 'Promise.resolve(globalThis.A)')
    .replace('import(`${FB}/firebase-firestore.js`)', 'Promise.resolve(globalThis.F)');
  const context = vm.createContext({
    A: { getAuth: () => ({}), connectAuthEmulator() {}, ...A },
    F: { getFirestore: () => ({}), connectFirestoreEmulator() {}, collection: () => ({}), ...F },
    APP: { initializeApp: config => { assert.equal(config.projectId, 'demo-nno'); return {}; } },
    location: { search: '?emulator=1', hostname: 'localhost', href: 'http://localhost:5173/?emulator=1' },
    URLSearchParams, structuredClone, setTimeout,
    localStorage: { getItem: k => local.get(k), setItem: (k, v) => local.set(k, v) },
  });
  vm.runInContext(source + '; globalThis.audit = { firebaseStore, demoStore };', context);
  return context.audit;
}

test('verification completion refreshes the token required by Firestore, not only the user record', async () => {
  let tokenVerified = false;
  const user = {
    emailVerified: false,
    async reload() { this.emailVerified = true; },
    async getIdToken(force) { if (force) tokenVerified = this.emailVerified; },
  };
  const store = await loadStore({ A: { getAuth: () => ({ currentUser: user }) } }).firebaseStore();
  assert.equal(await store.reloadUser(), true);
  assert.equal(tokenVerified, true, 'Firestore would still deny a token with email_verified=false');
});
