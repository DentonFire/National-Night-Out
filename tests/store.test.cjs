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
  source = source.replace('import { UNITS } from "./roster.js";', 'const UNITS = new Map([["E1",{}],["M1",{}]]);');
  source = source.replace(/export /g, '')
    .replace('import(`${FB}/firebase-app.js`)', 'Promise.resolve(APP)')
    .replace('import(`${FB}/firebase-auth.js`)', 'Promise.resolve(globalThis.A)')
    .replace('import(`${FB}/firebase-firestore.js`)', 'Promise.resolve(globalThis.F)');
  const context = vm.createContext({
    A: { getAuth: () => ({}), connectAuthEmulator() {}, ...A },
    F: { getFirestore: () => ({}), connectFirestoreEmulator() {}, collection: () => ({}), ...F },
    APP: { initializeApp: config => { assert.equal(config.projectId, 'demo-nno'); return {}; } },
    location: { search: '?emulator=1', hostname: 'localhost', href: 'http://localhost:5173/?emulator=1' },
    URL, URLSearchParams, structuredClone, setTimeout,
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


test('unit moves commit both endpoints together, including a rejected destination', async () => {
  let docs = { source: ['E1'], target: [] };
  let fail = false, commits = 0, writes = 0;
  const F = {
    doc: (_, col, id) => id,
    serverTimestamp: () => 0,
    arrayUnion: u => ({ add: u }), arrayRemove: u => ({ remove: u }),
    updateDoc: () => { writes++; throw new Error('Independent writes are forbidden in a move'); },
    writeBatch: () => {
      const updates = [];
      return {
        update: (id, data) => updates.push([id, data]),
        commit: async () => {
          commits++;
          if (fail) throw new Error('permission-denied');
          const next = structuredClone(docs);
          for (const [id, data] of updates) {
            if (data.units.add && !next[id].includes(data.units.add)) next[id].push(data.units.add);
            if (data.units.remove) next[id] = next[id].filter(u => u !== data.units.remove);
          }
          docs = next;
        },
      };
    },
  };
  const store = await loadStore({ F }).firebaseStore();
  await store.moveUnit('source', 'target', 'E1');
  assert.deepEqual(docs, { source: [], target: ['E1'] });
  assert.equal(commits, 1); assert.equal(writes, 0);
  docs = { source: ['E1'], target: [] }; fail = true;
  await assert.rejects(store.moveUnit('source', 'target', 'E1'), /permission-denied/);
  assert.deepEqual(docs, { source: ['E1'], target: [] });
});

test('demo moves publish one complete snapshot and reject missing parties without mutation', async () => {
  const store = loadStore().demoStore();
  const snapshot = () => new Promise(resolve => { const off = store.subscribeParties(p => { off(); resolve(p); }); });
  const parties = await snapshot();
  const from = parties[0].id, to = parties[1].id;
  await store.assignUnit(from, 'E1');
  let callbacks = 0;
  const off = store.subscribeParties(p => { callbacks++; assert.equal(p.find(x => x.id === from).units.includes('E1'), false); assert.equal(p.find(x => x.id === to).units.includes('E1'), true); });
  await store.moveUnit(from, to, 'E1');
  off(); assert.equal(callbacks, 1);
  await assert.rejects(store.moveUnit(to, 'missing', 'E1'), /no longer exists/);
  assert.equal((await snapshot()).find(x => x.id === to).units.includes('E1'), true);
});


test('party and lock listeners include metadata-only changes and preserve canonical party IDs', async () => {
  const calls = [];
  const F = {
    doc: () => 'event',
    onSnapshot: (...args) => { calls.push(args); return () => {}; },
  };
  const store = await loadStore({ F }).firebaseStore();
  let party, event;
  store.subscribeParties((p, m) => { party = { p, m }; });
  store.subscribeEvent((e, m) => { event = { e, m }; });
  assert.equal(calls[0][1].includeMetadataChanges, true);
  assert.equal(calls[1][1].includeMetadataChanges, true);
  calls[0][2]({ docs: [{ id: 'canonical', data: () => ({ id: 'spoofed' }) }], metadata: { fromCache: true, hasPendingWrites: true } });
  calls[1][2]({ exists: () => false, metadata: { fromCache: true, hasPendingWrites: false } });
  assert.equal(party.p[0].id, 'canonical');
  assert.equal(party.m.fromCache, true); assert.equal(party.m.hasPendingWrites, true);
  assert.equal(event.m.fromCache, true); assert.equal(event.m.hasPendingWrites, false);
});


test('updated imports preserve current server assignments and pins, not the stale preview', async () => {
  let writes = [], reads = [];
  const current = { units:['M1'], mayor:true, pinMoved:true, lat:33.3, lng:-97.2, fireDistrict:'1' };
  const F = {
    doc: (_, col, id) => id, serverTimestamp: () => 0,
    writeBatch: () => ({ set:(id,p)=>writes.push([id,p]), delete:()=>{}, commit:async()=>{} }),
    runTransaction: async (_, callback) => callback({
      get: async id => { reads.push(id); return { exists:()=>true, data:()=>current }; },
      set: (id, p) => writes.push([id,p]), delete: () => {},
    }),
  };
  const store = await loadStore({ F }).firebaseStore();
  const stale = new Map([['synthetic', { units:[], mayor:false }]]);
  await store.importParties([{id:'synthetic',name:'Synthetic',lat:33.2,lng:-97.1}],stale);
  assert.equal(reads.length,1); assert.equal(writes.length,1);
  assert.deepEqual(writes[0][1].units,['M1']);assert.equal(writes[0][1].mayor,true);assert.equal(writes[0][1].lat,33.3);
  await assert.rejects(store.importParties([{id:'collision'},{id:'collision'}],stale), /unique/);
  assert.equal(writes.length,1);
  await store.importParties([{id:'synthetic',name:'Synthetic',mayor:false}],stale,{replace:true});
  assert.equal(writes[1][1].units.length,0);assert.equal(writes[1][1].mayor,false);
});


test('untrusted stored fields cannot reach raw time attributes or coordinate URLs', async () => {
  let listener, received;
  const F = { onSnapshot: (_, options, cb) => { listener=cb; return ()=>{}; } };
  const store=await loadStore({F}).firebaseStore();store.subscribeParties(p=>received=p);
  listener({metadata:{fromCache:false,hasPendingWrites:false},docs:[{id:'canonical',data:()=>({
    id:'spoofed',name:'Synthetic <img src=x>',start:'17:00" onmouseover="alert(1)',end:'18:00',
    lat:'33.2"><img src=x onerror="alert(1)">',lng:-97.1,units:['E1','unexpected','E1'],depts:['Synthetic department',{}],
    partyHostName:'Synthetic forbidden field',
  })}]});
  assert.equal(received[0].id,'canonical');assert.equal(received[0].start,'');
  assert.equal(received[0].lat,null);assert.equal(received[0].lng,null);
  assert.equal(received[0].partyHostName,undefined);
  assert.equal(received[0].units.length,1);assert.equal(received[0].depts.length,1);
  // Text is preserved for esc() at the renderer, so legitimate punctuation isn't lost.
  assert.equal(received[0].name,'Synthetic <img src=x>');
});


test('a late role lookup cannot restore a signed-out user or leak an unsubscribed auth callback', async () => {
  let callback, finish;
  const user={email:'audit.owner@cityofdenton.com',emailVerified:true};
  const auth={currentUser:user}, seen=[];
  const store=await loadStore({A:{getAuth:()=>auth,onAuthStateChanged:(_,cb)=>{callback=cb;return()=>{};}},F:{doc:()=>({}),getDoc:()=>new Promise(resolve=>finish=resolve)}}).firebaseStore();
  const off=store.onAuth(value=>seen.push(value));
  const pending=callback(user);auth.currentUser=null;await callback(null);
  finish({exists:()=>true,data:()=>({role:'owner'})});await pending;
  assert.equal(seen.length,1);assert.equal(seen[0].user,null);
  auth.currentUser=user;const late=callback(user);off();finish({exists:()=>true,data:()=>({role:'owner'})});await late;
  assert.equal(seen.length,1);
});


test('emulator email-action continuation cannot drop the emulator mode', async () => {
  const urls=[];const user={};
  const store=await loadStore({A:{getAuth:()=>({currentUser:user}),createUserWithEmailAndPassword:async()=>({user}),sendEmailVerification:async(_,settings)=>urls.push(settings.url),sendPasswordResetEmail:async(_,email,settings)=>urls.push(settings.url),signOut:async()=>{}}}).firebaseStore();
  await store.signUp('audit.tester@cityofdenton.com','Synthetic passphrase');
  await store.resetPassword('audit.tester@cityofdenton.com');await store.resendVerification();
  assert.equal(urls.length,3);for(const url of urls)assert.equal(url,'http://localhost:5173/?emulator=1');
});
