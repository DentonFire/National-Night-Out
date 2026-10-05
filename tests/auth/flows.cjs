// Auth uses demo-nno on loopback. Firestore is an in-browser stub; this is not a rules test.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.NNO_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const emulator = 'http://127.0.0.1:9099';
const password = 'Synthetic audit passphrase 42!';
const rpc = async (method, body) => {
  const r = await fetch(`${emulator}/identitytoolkit.googleapis.com/v1/accounts:${method}?key=demo-key`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) });
  return { status:r.status, body:await r.json() };
};
const firestore = `
export const getFirestore = () => ({}), connectFirestoreEmulator = () => {}, collection = (_, path) => path, doc = (_, ...parts) => parts.join('/');
export const getDoc = async () => ({ exists: () => false });
const listeners = {};
const parties = [{id:'synthetic-party',name:'Synthetic Audit Party',address:'Synthetic location',notes:'',council:'1',start:'17:00',end:'18:00',attendance:'',depts:[],guests:'',police:false,mayor:false,units:['E1'],lat:33.2,lng:-97.1,fireDistrict:'1'}];
window.__emit = (path, metadata, data) => listeners[path]?.next({metadata,docs:(data || parties).map(p=>({id:p.id,data:()=>p})),exists:()=>true,data:()=>({finalized:false})});
window.__error = (path, code) => listeners[path]?.error({code});
export const onSnapshot = (path, options, next, error) => {
 if(typeof options==='function'){error=next;next=options;}
 listeners[path]={next,error};queueMicrotask(()=>window.__emit(path,{fromCache:true,hasPendingWrites:false}));
 return ()=>delete listeners[path];
};`;
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.NNO_BROWSER_EXECUTABLE?{executablePath:process.env.NNO_BROWSER_EXECUTABLE}:{})});
 try {
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  const forbidden=[];
  await context.route('**/*',route=>{
   const u=new URL(route.request().url());
   if(['localhost','127.0.0.1'].includes(u.hostname)||['www.gstatic.com','unpkg.com','cdn.tailwindcss.com','cdnjs.cloudflare.com','fonts.googleapis.com','fonts.gstatic.com','files.constantcontact.com','server.arcgisonline.com','www.transparenttextures.com'].includes(u.hostname))return route.continue();
   if(/googleapis[.]com|firebaseio[.]com|firebaseapp[.]com/.test(u.hostname))forbidden.push(u.origin);
   return route.abort();
  });
  await context.route('**/firebase-firestore.js',route=>route.fulfill({contentType:'text/javascript',body:firestore}));
  const page=await context.newPage(), errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://localhost:5173/?emulator=1');
  await page.waitForFunction(()=>document.querySelector('#secure-text').textContent==='Secure sign-in');
  const submit=async(email,pass=password)=>{await page.locator('#email').fill(email);await page.locator('#password').fill(pass);await page.locator('#login-btn').click();await page.waitForFunction(()=>!document.querySelector('#login-btn').disabled);};
  await submit('audit.outside@example.com');assert.match(await page.locator('#login-msg').innerText(),/Restricted/);
  await submit(`audit.unknown.${Date.now()}@cityofdenton.com`);assert.equal(await page.locator('#login-msg').innerText(),'Wrong email or password');
  const signInRoute='**/accounts:signInWithPassword*';
  await context.route(signInRoute,route=>route.fulfill({status:429,contentType:'application/json',body:JSON.stringify({error:{code:429,message:'TOO_MANY_ATTEMPTS_TRY_LATER'}})}));
  await submit('audit.rate@cityofdenton.com');assert.match(await page.locator('#login-msg').innerText(),/Too many attempts/);
  await context.unroute(signInRoute);
  await context.route(signInRoute,route=>route.abort('internetdisconnected'));
  await submit('audit.offline@cityofdenton.com');assert.match(await page.locator('#login-msg').innerText(),/No connection/);
  await context.unroute(signInRoute);
  const oobRoute='**/accounts:sendOobCode*';
  await context.route(oobRoute,route=>route.abort('internetdisconnected'));
  await page.locator('#email').fill('audit.offline@cityofdenton.com');await page.locator('#forgot-btn').click();
  await page.waitForFunction(()=>!document.querySelector('#forgot-btn').disabled);
  assert.match(await page.locator('#login-msg').innerText(),/network-request-failed/);
  await context.unroute(oobRoute);
  await page.locator('#auth-toggle').click();await submit('audit.weak@cityofdenton.com','123');assert.match(await page.locator('#login-msg').innerText(),/at least 6/);
  const email=`audit.flow.${Date.now()}@cityofdenton.com`;
  await submit(email);assert.match(await page.locator('#login-msg').innerText(),/Account created/);
  await page.locator('#auth-toggle').click();await submit(email);assert.match(await page.locator('#login-msg').innerText(),/already has an account/);
  await page.locator('#auth-toggle').click();await submit(email,'Incorrect synthetic password');assert.equal(await page.locator('#login-msg').innerText(),'Wrong email or password');
  await submit(email);await page.locator('#verify-modal').waitFor({state:'visible'});
  assert.equal(await page.locator('#app').isVisible(),false);
  await context.route(oobRoute,route=>route.fulfill({status:429,contentType:'application/json',body:JSON.stringify({error:{code:429,message:'TOO_MANY_ATTEMPTS_TRY_LATER'}})}));
  await page.locator('#verify-resend').click();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('auth/too-many-requests'));
  assert.equal(await page.locator('#verify-modal').isVisible(),true);
  await context.unroute(oobRoute);
  await page.locator('#verify-resend').click();await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Verification email sent');
  await page.locator('#verify-cancel').click();await page.locator('#verify-modal').waitFor({state:'hidden'});
  await page.locator('#email').fill(`  ${email.toUpperCase()}  `);await page.locator('#forgot-btn').click();
  await page.waitForFunction(()=>document.querySelector('#login-msg').textContent.includes('reset link is on its way'));
  const codes=await (await fetch(`${emulator}/emulator/v1/projects/demo-nno/oobCodes`)).json();
  const reset=codes.oobCodes.find(c=>c.email===email&&c.requestType==='PASSWORD_RESET');assert.ok(reset);
  const nextPassword='New synthetic audit passphrase 43!';
  assert.equal((await rpc('resetPassword',{oobCode:reset.oobCode,newPassword:nextPassword})).status,200);
  assert.equal((await rpc('resetPassword',{oobCode:reset.oobCode,newPassword:password})).status,400);
  assert.equal((await rpc('signInWithPassword',{email,password,returnSecureToken:true})).status,400);
  assert.equal((await rpc('signInWithPassword',{email,password:nextPassword,returnSecureToken:true})).status,200);
  await submit(email,nextPassword);
  await page.waitForFunction(()=>!document.querySelector('#app').classList.contains('hidden')||!document.querySelector('#verify-modal').classList.contains('hidden'));
  // Password recovery also proves inbox ownership in the Auth emulator.
  if(await page.locator('#verify-modal').isVisible()) {
    const verification=codes.oobCodes.filter(c=>c.email===email&&c.requestType==='VERIFY_EMAIL').at(-1);assert.ok(verification);
    assert.equal((await rpc('update',{oobCode:verification.oobCode})).status,200);
  }
  await page.locator('#app').waitFor({state:'visible',timeout:20000});
  await page.waitForFunction(()=>document.querySelector('#parties-pane').textContent.includes('Synthetic Audit Party'));
  await page.evaluate(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})));
  assert.doesNotMatch(await page.locator('#status-text').innerText(),/live.*synced/i);
  await page.evaluate(()=>window.__emit('parties',{fromCache:false,hasPendingWrites:false}));
  assert.doesNotMatch(await page.locator('#status-text').innerText(),/live.*synced/i);
  await page.evaluate(()=>window.__emit('config/event',{fromCache:false,hasPendingWrites:false}));
  assert.match(await page.locator('#status-text').innerText(),/live.*synced/i);
  await page.evaluate(()=>window.__emit('parties',{fromCache:false,hasPendingWrites:true}));
  assert.match(await page.locator('#status-text').innerText(),/Saving changes/i);
  await page.evaluate(()=>window.__emit('parties',{fromCache:true,hasPendingWrites:false}));
  assert.match(await page.locator('#status-text').innerText(),/Cached/i);
  await page.locator('#tab-parties').click();assert.match(await page.locator('#status-text').innerText(),/Cached/i);
  await page.evaluate(()=>window.__error('config/event','unavailable'));assert.match(await page.locator('#status-text').innerText(),/confirm map lock/i);
  await page.locator('#tab-units').click();assert.match(await page.locator('#status-text').innerText(),/confirm map lock/i);
  await page.evaluate(()=>{window.__emit('parties',{fromCache:false,hasPendingWrites:false});window.__emit('config/event',{fromCache:false,hasPendingWrites:false});});
  await context.setOffline(true);await page.waitForFunction(()=>document.querySelector('#status-text').textContent.includes('Offline'));
  await context.setOffline(false);
  await page.evaluate(()=>window.__emit('parties',{fromCache:true,hasPendingWrites:false}));
  assert.doesNotMatch(await page.locator('#status-text').innerText(),/live.*synced/i);
  await page.setViewportSize({width:390,height:844});
  if(process.env.NNO_EVIDENCE_DIR){fs.mkdirSync(process.env.NNO_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:`${process.env.NNO_EVIDENCE_DIR}/auth-synthetic-mobile.png`});}
  await page.setViewportSize({width:1440,height:900});
  await page.evaluate(()=>window.__emit('parties',{fromCache:false,hasPendingWrites:false},[{
    id:'synthetic-injection',name:'Synthetic <img src=x onerror="window.__auditXSS=1">',address:'Synthetic " address',notes:'<svg onload="window.__auditXSS=1">',council:'1',
    start:'17:00"><img src=x onerror="window.__auditXSS=1">',end:'18:00',units:['E1'],depts:['<img src=x onerror="window.__auditXSS=1">'],
    lat:'33.2"><img src=x onerror="window.__auditXSS=1">',lng:-97.1,fireDistrict:'1',
  }]));
  await page.locator('#tab-parties').click();await page.locator('#parties-pane [data-party="synthetic-injection"]').click();
  assert.equal(await page.locator('#detail a[href*="maps"]').count(),0);
  assert.equal(await page.locator('#time-filter img, #detail img, #parties-pane img').count(),0);
  assert.equal(await page.evaluate(()=>window.__auditXSS),undefined);
  await page.locator('#detail-close').click();
  await page.locator('#tab-mine').click();await page.locator('[data-pick-unit="E1"]').click();
  assert.equal(await page.evaluate(()=>localStorage.getItem('nno-my-unit')),'E1');
  await page.evaluate(()=>{localStorage.setItem('nno-tour-crew-v1','done');document.querySelector('#qr-dialog').showModal();});
  await page.locator('#qr-dialog .dialog-close').click();
  page.once('dialog',dialog=>dialog.accept());await page.locator('#logout-btn').click();
  await page.locator('#app').waitFor({state:'hidden'});
  assert.equal(await page.locator('#password').inputValue(),'');
  assert.equal(await page.locator('#parties-pane [data-party]').count(),0);
  assert.equal(await page.locator('dialog[open]').count(),0);
  assert.equal(await page.evaluate(()=>localStorage.getItem('nno-my-unit')),null);
  assert.equal(await page.evaluate(()=>localStorage.getItem('nno-tour-crew-v1')),null);
  await submit(email,nextPassword);await page.locator('#app').waitFor({state:'visible'});
  await page.locator('#tab-mine').click();assert.match(await page.locator('#mine-pane').innerText(),/Which unit/);
  assert.deepEqual(errors,[]);assert.deepEqual(forbidden,[]);
  console.log('PASS: domain, unknown/wrong login, weak/duplicate signup, unverified gate/resend, normalized reset, reused reset, old/new password, verification, rate-limit/offline error handling, metadata status/errors, stored XSS, sign-out isolation (Firestore stub)');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
