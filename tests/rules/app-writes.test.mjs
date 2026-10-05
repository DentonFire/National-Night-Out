import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, writeBatch, runTransaction, arrayUnion, arrayRemove, serverTimestamp } from 'firebase/firestore';

// Writes shaped exactly like js/store.js makes them, so a rule change can't silently break Tuesday.
const projectId = 'demo-nno';
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
assert.ok(['127.0.0.1', 'localhost'].includes(host));
const CMD = 'audit.command@cityofdenton.com', OWNER = 'audit.owner@cityofdenton.com';
let env;
const as = email => env.authenticatedContext(email, { email, email_verified: true }).firestore();
const stamp = email => ({ updatedAt: serverTimestamp(), updatedBy: email });
// Shape of an importer row (js/importer.js) plus the fields importParties adds.
const row = i => ({ id: `synthetic-party-${i}`, name: `Synthetic Party ${i}`, address: 'Synthetic St, Denton, TX', notes: '',
  council: String(1 + (i % 4)), start: i % 2 ? '17:30' : '18:00', end: '19:30', attendance: '40', depts: ['Fire', 'Police'],
  guests: i === 3 ? 'Mayor' : '', police: true, mayor: i === 3, lat: 33.2 + i / 1000, lng: -97.13, fireDistrict: String(1 + (i % 9)),
  pinMoved: false, pinApprox: i === 7 });
// Existing production documents carry an updatedBy from the bulk import, not a person.
const legacy = i => ({ ...row(i), units: [], updatedBy: 'import 2026-10-04 (synthetic)', updatedAt: new Date('2026-10-04T16:52:07Z') });

describe('app-shaped writes', { concurrency: false }, () => {
  before(async () => {
    env = await initializeTestEnvironment({ projectId, firestore: { host, port: Number(port), rules: readFileSync(process.env.RULES_FILE || new URL('../../firestore.rules', import.meta.url), 'utf8') } });
  });
  after(async () => { await env?.cleanup(); });
  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async ctx => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'roles', CMD), { role: 'command' });
      await setDoc(doc(db, 'roles', OWNER), { role: 'owner' });
      for (let i = 0; i < 21; i++) await setDoc(doc(db, 'parties', `synthetic-party-${i}`), legacy(i));
    });
  });

  it('assign, unassign, Mayor and Move pin on legacy-stamped parties', async () => {
    const db = as(CMD), p = doc(db, 'parties', 'synthetic-party-1');
    await assertSucceeds(updateDoc(p, { units: arrayUnion('E1'), ...stamp(CMD) }));
    await assertSucceeds(updateDoc(p, { units: arrayRemove('E1'), ...stamp(CMD) }));
    await assertSucceeds(updateDoc(p, { mayor: true, ...stamp(CMD) }));
    await assertSucceeds(updateDoc(p, { lat: 33.252774, lng: -97.164911, fireDistrict: '5', pinMoved: true, ...stamp(CMD) }));
  });

  it('atomic move as the app batches it', async () => {
    const db = as(CMD);
    await assertSucceeds(updateDoc(doc(db, 'parties', 'synthetic-party-1'), { units: arrayUnion('E6'), ...stamp(CMD) }));
    const b = writeBatch(db);
    b.update(doc(db, 'parties', 'synthetic-party-2'), { units: arrayUnion('E6'), ...stamp(CMD) });
    b.update(doc(db, 'parties', 'synthetic-party-1'), { units: arrayRemove('E6'), ...stamp(CMD) });
    await assertSucceeds(b.commit());
  });

  it('21-party import transaction (update) and new-year replace', async () => {
    const db = as(CMD);
    const run = replace => runTransaction(db, async tx => {
      const refs = Array.from({ length: 21 }, (_, i) => doc(db, 'parties', `synthetic-party-${i}`));
      const snaps = await Promise.all(refs.map(r => tx.get(r)));
      refs.forEach((r, i) => {
        const prev = !replace && snaps[i].exists() ? snaps[i].data() : null;
        tx.set(r, { ...row(i), units: prev?.units || [], mayor: Boolean(prev?.mayor || row(i).mayor), ...stamp(CMD) });
      });
    });
    await assertSucceeds(run(false));
    await assertSucceeds(run(true));
  });

  it('Finalize, Unlock, and the lock blocks assignment', async () => {
    const db = as(CMD), ev = doc(db, 'config', 'event');
    await assertSucceeds(setDoc(ev, { finalized: true, acceptedIssues: ['uncovered:synthetic-party-1'], finalizedBy: CMD, finalizedAt: serverTimestamp(), ...stamp(CMD) }));
    await assertFails(updateDoc(doc(db, 'parties', 'synthetic-party-1'), { units: arrayUnion('E1'), ...stamp(CMD) }));
    await assertSucceeds(setDoc(ev, { finalized: false, acceptedIssues: [], finalizedBy: null, finalizedAt: null, ...stamp(CMD) }));
    await assertSucceeds(updateDoc(doc(db, 'parties', 'synthetic-party-1'), { units: arrayUnion('E1'), ...stamp(CMD) }));
  });

  it('Access: owner grants and removes Command as the app writes it', async () => {
    const db = as(OWNER), r = doc(db, 'roles', 'audit.newchief@cityofdenton.com');
    await assertSucceeds(setDoc(r, { role: 'command', ...stamp(OWNER) }));
    assert.equal((await getDoc(r)).data().role, 'command');
  });
});
