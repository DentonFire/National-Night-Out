import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch } from 'firebase/firestore';

// This suite never selects a real project and refuses non-loopback emulator endpoints.
const projectId = 'demo-nno';
const address = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const [host, port] = address.split(':');
assert.ok(['127.0.0.1', 'localhost'].includes(host), 'Only a loopback Firestore emulator is allowed');
const emails = { crew:'audit.crew@cityofdenton.com', command:'audit.command@cityofdenton.com', owner:'audit.owner@cityofdenton.com', outside:'audit.outside@example.com' };
const partyId = 'synthetic-party';
const party = () => ({id:partyId,name:'Synthetic Audit Party',address:'Synthetic location',notes:'',lat:33.2,lng:-97.1,council:'1',fireDistrict:'1',start:'17:00',end:'18:00',attendance:'',depts:['Fire'],guests:'',police:false,mayor:false,units:['E1'],pinMoved:false,pinApprox:false});
const event = finalized => ({finalized,acceptedIssues:[]});
let env;
const user = (role, verified=true) => env.authenticatedContext(`synthetic-${role}-${verified}`, {email:emails[role],email_verified:verified}).firestore();
const seed = data => env.withSecurityRulesDisabled(async context => {
  const db=context.firestore();
  for(const [path,value] of Object.entries(data)) await setDoc(doc(db,path),value);
});
const pdoc = db => doc(db,'parties',partyId);

describe('National Night Out authorization and data boundaries', {concurrency:false}, () => {
  before(async () => {
    env=await initializeTestEnvironment({projectId,firestore:{host,port:Number(port),rules:readFileSync(process.env.RULES_FILE || new URL('../../firestore.rules',import.meta.url),'utf8')}});
  });
  after(async()=>{await env?.cleanup();});
  beforeEach(async()=>{
    await env.clearFirestore();
    await seed({[`roles/${emails.command}`]:{role:'command'},[`roles/${emails.owner}`]:{role:'owner'},[`parties/${partyId}`]:party(),'config/event':event(false)});
  });
  it('rejects anonymous, unverified city, and verified outside-domain reads and writes',async()=>{
    for(const db of [env.unauthenticatedContext().firestore(),user('crew',false),user('outside')]) {
      await assertFails(getDoc(pdoc(db)));await assertFails(getDocs(collection(db,'parties')));
      await assertFails(getDoc(doc(db,'config/event')));await assertFails(updateDoc(pdoc(db),{units:['M1']}));
      await assertFails(setDoc(doc(db,'roles',emails.crew),{role:'owner'}));
    }
    await assertFails(getDoc(doc(user('owner',false),'roles',emails.owner)));
  });
  it('allows verified city crew without a role to read parties and lock, but not write or enumerate roles',async()=>{
    const db=user('crew');await assertSucceeds(getDoc(pdoc(db)));await assertSucceeds(getDocs(collection(db,'parties')));
    await assertSucceeds(getDoc(doc(db,'config/event')));await assertSucceeds(getDoc(doc(db,'roles',emails.crew)));
    await assertFails(updateDoc(pdoc(db),{units:['M1']}));await assertFails(deleteDoc(pdoc(db)));
    await assertFails(setDoc(doc(db,'config/event'),event(true)));await assertFails(getDocs(collection(db,'roles')));
    await assertFails(getDoc(doc(db,'roles',emails.command)));
  });
  it('lets command assign, move pins, create and delete valid parties while unlocked',async()=>{
    const db=user('command');await assertSucceeds(updateDoc(pdoc(db),{units:['M1'],mayor:true}));
    await assertSucceeds(updateDoc(pdoc(db),{lat:33.3,lng:-97.2,fireDistrict:'2',pinMoved:true}));
    await assertSucceeds(setDoc(doc(db,'parties','synthetic-second'),{...party(),id:'synthetic-second',lat:null,lng:null,fireDistrict:null}));
    await assertSucceeds(deleteDoc(doc(db,'parties','synthetic-second')));
    await assertSucceeds(getDoc(doc(db,'roles',emails.command)));await assertFails(getDocs(collection(db,'roles')));
    await assertFails(setDoc(doc(db,'roles',emails.crew),{role:'command'}));await assertFails(deleteDoc(doc(db,'roles',emails.owner)));
  });
  it('locks all party writes while allowing command to explicitly unlock',async()=>{
    await seed({'config/event':event(true)});const db=user('command');
    await assertFails(updateDoc(pdoc(db),{units:['M1']}));await assertFails(deleteDoc(pdoc(db)));
    await assertFails(setDoc(doc(db,'parties','synthetic-second'),{...party(),id:'synthetic-second'}));
    await assertSucceeds(setDoc(doc(db,'config/event'),event(false)));await assertSucceeds(updateDoc(pdoc(db),{units:['M1']}));
    await assertFails(deleteDoc(doc(db,'config/event')));
  });
  it('permits only owners to manage city roles and prevents self-demotion',async()=>{
    const db=user('owner');await assertSucceeds(getDocs(collection(db,'roles')));
    await assertSucceeds(setDoc(doc(db,'roles',emails.crew),{role:'command'}));
    await assertSucceeds(deleteDoc(doc(db,'roles',emails.crew)));
    await assertFails(setDoc(doc(db,'roles',emails.outside),{role:'command'}));
    await assertFails(deleteDoc(doc(db,'roles',emails.owner)));
    await assertFails(setDoc(doc(db,'roles',emails.owner),{role:'command'}));
    await assertFails(setDoc(doc(db,'roles',emails.crew),{role:'admin'}));
    await assertFails(setDoc(doc(db,'roles',emails.crew),{role:'command',personalField:'Synthetic forbidden value'}));
  });
  it('rejects every extra personal field on create and update',async()=>{
    const db=user('command');
    for(const field of ['host','hostName','partyHostName','contactName','email','phone','nestedContact']) {
      await assertFails(updateDoc(pdoc(db),{[field]:'Synthetic forbidden value'}));
      await assertFails(setDoc(doc(db,'parties','synthetic-extra'),{...party(),id:'synthetic-extra',[field]:'Synthetic forbidden value'}));
    }
    await assertFails(updateDoc(doc(db,'config/event'),{personalField:'Synthetic forbidden value'}));
  });
  it('rejects spoofed IDs, unsafe coordinates/times, and unknown units',async()=>{
    const db=user('command');
    for(const patch of [{id:'spoofed'},{lat:'33.2" onmouseover="alert(1)'},{lat:91},{lng:-181},{lat:null,lng:-97.1},{start:'17:00" onclick="alert(1)'},{end:'25:00'},{units:['E1','UNKNOWN']},{units:'E1'},{mayor:'true'}]) await assertFails(updateDoc(pdoc(db),patch));
    await assertSucceeds(updateDoc(pdoc(db),{start:'',end:'',lat:null,lng:null}));
  });
  it('atomically moves a unit and rejects the whole batch when one destination is invalid',async()=>{
    const db=user('command');await assertSucceeds(setDoc(doc(db,'parties','synthetic-second'),{...party(),id:'synthetic-second',units:[]}));
    let batch=writeBatch(db);batch.update(pdoc(db),{units:[]});batch.update(doc(db,'parties','synthetic-second'),{units:['E1']});await assertSucceeds(batch.commit());
    assert.deepEqual((await getDoc(pdoc(db))).data().units,[]);assert.deepEqual((await getDoc(doc(db,'parties','synthetic-second'))).data().units,['E1']);
    batch=writeBatch(db);batch.update(doc(db,'parties','synthetic-second'),{units:[]});batch.update(pdoc(db),{units:['UNKNOWN']});await assertFails(batch.commit());
    assert.deepEqual((await getDoc(doc(db,'parties','synthetic-second'))).data().units,['E1']);
  });
  it('denies unexpected collections, configuration documents and subcollections',async()=>{
    for(const path of ['config/other','unlisted/synthetic','parties/synthetic-party/private/synthetic']) {
      await assertFails(getDoc(doc(user('owner'),path)));await assertFails(setDoc(doc(user('owner'),path),{value:'Synthetic'}));
    }
  });
});
