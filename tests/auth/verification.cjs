// Synthetic identities only. Requires localhost Auth emulator + static server; never production.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.NNO_PLAYWRIGHT_MODULE || 'playwright');
const base = 'http://localhost:5173/?emulator=1';
const emulator = 'http://127.0.0.1:9099';
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.NNO_BROWSER_EXECUTABLE ? { executablePath: process.env.NNO_BROWSER_EXECUTABLE } : {}) });
  try {
    const context = await browser.newContext();
    const forbidden = [];
    await context.route('**/*', route => {
      const u = new URL(route.request().url());
      const local = ['localhost', '127.0.0.1'].includes(u.hostname);
      const asset = ['www.gstatic.com', 'unpkg.com', 'cdn.tailwindcss.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'files.constantcontact.com', 'server.arcgisonline.com', 'www.transparenttextures.com'].includes(u.hostname);
      if (local || asset) return route.continue();
      if (/googleapis[.]com|firebaseio[.]com|firebaseapp[.]com/.test(u.hostname)) forbidden.push(u.origin);
      return route.abort();
    });
    await context.route('**/js/store.js*', async route => {
      const response = await route.fetch();
      let body = await response.text();
      if (process.env.NNO_REMOVE_CONTROL === 'verification') body = body.replace('await user.getIdToken(true);', '// removal drill: token refresh omitted');
      // Capture the token at completion, before a later SDK request can refresh it incidentally.
      body = body.replace('return auth.currentUser === user;', 'sessionStorage.setItem("audit-verification-token", String((await user.getIdTokenResult()).claims.email_verified)); return auth.currentUser === user;');
      await route.fulfill({ response, body });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('#secure-text').textContent === 'Secure sign-in');
    assert.equal(await page.title(), 'NNO Map | Denton Fire');
    const email = `audit.verify.${Date.now()}@cityofdenton.com`;
    await page.locator('#auth-toggle').click();
    await page.locator('#email').fill(email);
    await page.locator('#password').fill('Synthetic audit passphrase 42!');
    await page.locator('#login-btn').click();
    await page.waitForFunction(() => document.querySelector('#login-msg').textContent.includes('Account created'));
    await page.locator('#password').fill('Synthetic audit passphrase 42!');
    await page.locator('#login-btn').click();
    await page.locator('#verify-modal').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#app').isVisible(), false);
    const before = await page.evaluate(async () => {
      const A = await import('https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js');
      return (await A.getIdTokenResult(A.getAuth().currentUser)).claims.email_verified;
    });
    assert.equal(before, false);
    await context.route('**/accounts:lookup*', route => route.abort('internetdisconnected'));
    await page.waitForTimeout(4000);
    assert.deepEqual(errors, [], 'offline verification polling must stay recoverable');
    await context.unroute('**/accounts:lookup*');
    const codes = await (await fetch(`${emulator}/emulator/v1/projects/demo-nno/oobCodes`)).json();
    const code = codes.oobCodes.find(c => c.email === email && c.requestType === 'VERIFY_EMAIL');
    assert.ok(code);
    // Consume the link in a separate browser context, like opening email on another device.
    const linkContext = await browser.newContext();
    await linkContext.route('**/*', route => {
      const u = new URL(route.request().url());
      if (['localhost', '127.0.0.1'].includes(u.hostname) || ['www.gstatic.com', 'unpkg.com', 'cdn.tailwindcss.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'files.constantcontact.com', 'server.arcgisonline.com', 'www.transparenttextures.com'].includes(u.hostname)) return route.continue();
      if (/googleapis[.]com|firebaseio[.]com|firebaseapp[.]com/.test(u.hostname)) forbidden.push(u.origin);
      return route.abort();
    });
    assert.equal(new URL(new URL(code.oobLink).searchParams.get('continueUrl')).searchParams.get('emulator'), '1');
    const linkPage = await linkContext.newPage();
    await linkPage.goto(code.oobLink);
    await linkPage.waitForTimeout(500);
    await page.waitForFunction(async () => {
      const A = await import('https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js');
      const user = A.getAuth().currentUser;
      return user?.emailVerified && (await A.getIdTokenResult(user)).claims.email_verified === true;
    }, null, { timeout: 25000 });
    await page.waitForFunction(() => sessionStorage.getItem('audit-verification-token') === 'true', null, { timeout: 10000 });
    assert.deepEqual(errors, []);
    assert.deepEqual(forbidden, []);
    console.log('PASS: sign-up, unverified gate, verification in another browser, refreshed email_verified token');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
