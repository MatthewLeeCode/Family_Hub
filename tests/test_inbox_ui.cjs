/**
 * Isolated browser regressions for the plain-JS Inbox. No app server is started.
 * Requires Node >=20, Playwright, and an installed browser; no downloads occur.
 * Run: node --test tests/test_inbox_ui.cjs
 * If Playwright is supplied by a runtime, set NODE_PATH to its node_modules.
 * INBOX_TEST_BROWSER_CHANNEL defaults to msedge on Windows; on Linux Playwright's
 * installed Chromium is used. Set the channel to chrome or chromium if needed.
 * Every browser request is intercepted. No live Family Hub/account is accessed.
 */
'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { before, after, test } = require('node:test');
const { chromium } = require('playwright');

const STATIC = path.resolve(__dirname, '../app/bookhub/static');
const ORIGIN = 'https://family-hub-inbox.invalid';
const CONTEXT = 'a'.repeat(64);
const source = (file) => readFileSync(path.join(STATIC, file), 'utf8');
const clone = (value) => JSON.parse(JSON.stringify(value));
let browser;

before(async () => {
  const channel = process.env.INBOX_TEST_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
  browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
});
after(async () => { await browser?.close(); });

function snapshot() {
  return {
    user: { id: 'user-matt', name: 'Matt' },
    spaces: [{ id: 'private', kind: 'private', name: 'Personal' }, { id: 'shared', kind: 'shared', name: 'Household' }],
    mailboxes: [
      { id: 'gmail', space_id: 'private', name: 'Personal Gmail', provider: 'Gmail', address: 'matt@example.test' },
      { id: 'outlook', space_id: 'private', name: 'Work Outlook', provider: 'Outlook', address: 'work@example.test' },
      { id: 'family', space_id: 'shared', name: 'Family mailbox', provider: 'Gmail', address: 'family@example.test' },
      { id: 'foreign', space_id: 'foreign', name: 'OTHER PRIVATE MAILBOX', provider: 'Gmail' },
    ],
    emails: [
      { id: 'insurance', space_id: 'private', mailbox_id: 'gmail', subject: 'Insurance renewal', sender: 'Insurance office', address: 'insurance@example.test', body: 'PRIVATE INSURANCE BODY', important: true, received_at: 1700000000000,
        attachments: [{ id: 'policy', name: 'policy.pdf', size: 2048 }] },
      { id: 'meeting', space_id: 'private', mailbox_id: 'outlook', subject: 'Meeting details', sender: 'Colleague', address: 'colleague@example.test', body: 'PRIVATE MEETING BODY', important: false, received_at: 1700000001000, attachments: [] },
      { id: 'family-message', space_id: 'shared', mailbox_id: 'family', subject: 'Household booking', sender: 'Reception', address: 'booking@example.test', body: 'SHARED BOOKING BODY', important: true, received_at: 1700000002000, attachments: [] },
      { id: 'foreign-message', space_id: 'foreign', mailbox_id: 'foreign', subject: 'OTHER PRIVATE MESSAGE', body: 'OTHER PRIVATE BODY', important: true },
      { id: 'wrong-mailbox', space_id: 'private', mailbox_id: 'foreign', subject: 'WRONG MAILBOX MESSAGE', body: 'WRONG MAILBOX BODY', important: true },
    ],
    drafts: [
      { id: 'draft-private', space_id: 'private', subject: 'Private draft', recipient: 'person@example.test', body: 'UNSENT PRIVATE BODY' },
      { id: 'draft-shared', space_id: 'shared', subject: 'Shared draft', recipient: 'family@example.test', body: 'UNSENT SHARED BODY' },
    ],
    assets: [{ space_id: 'private', source_message: 'insurance', source_attachment: 'policy' }],
  };
}

async function fixture(t, { profile = {}, status = {}, data = snapshot(), hash = '#/inbox', viewport } = {}) {
  const context = await browser.newContext({ ...(viewport ? { viewport } : {}), serviceWorkers: 'block' });
  t.after(async () => { await context.close(); });
  const requests = [], unexpected = [], errors = [];
  const control = {
    data,
    next: null,
    status: { configured: true, signed_in: true, ...status },
    requests,
    async holdNextSnapshot() {
      let start, finish;
      const started = new Promise((resolve) => { start = resolve; });
      const response = new Promise((resolve) => { finish = resolve; });
      this.next = async () => { start(); return response; };
      return { started, release: (body = clone(this.data), code = 200) => finish({ body, code }) };
    },
  };
  const familyState = {
    me: { id: 1, name: 'Matt', role: 'member', guest: false, via_admin: false, ...profile },
    assistant_context: CONTEXT, setup_needed: false, series: false, kinds: [],
    look: { design: 'minimalist', theme: 'dark', layout: 'compact', accent: null, fonts: '/fixture/empty.css', sep: ' / ', transition: false },
  };
  const html = source('index.html')
    .replaceAll('__DESIGN__', 'minimalist').replaceAll('__THEME__', 'dark')
    .replaceAll('__LAYOUT__', 'compact').replaceAll('__ACCENT__', '').replaceAll('__FONTS__', '/fixture/empty.css')
    .replace(/<link rel="preconnect"[^>]*>/g, '')
    .replace('<script src="/static/setpieces.js"></script>', '<script src="/fixture/dependencies.js"></script>')
    .replace('<script src="/static/assistant.js"></script>', '')
    .replace('<script src="/static/notes.js"></script>', '');
  await context.route('**/*', async (route) => {
    const req = route.request(); const url = new URL(req.url());
    if (url.origin !== ORIGIN) { unexpected.push(req.url()); return route.abort(); }
    const json = (body, code = 200) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname === '/notice') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Test notification sender</title>' });
    if (url.pathname === '/fixture/dependencies.js') return route.fulfill({ contentType: 'text/javascript', body:
      'window.cleared={assistant:0,notes:0}; const AssistantUI={leave(){},identity(){},page(){},sessionChanged(){cleared.assistant++;}}; const NotesUI={leave(){},identity(){},page(){},sessionChanged(){cleared.notes++;}}; const SetPieces={transition(){}};' });
    if (url.pathname === '/fixture/empty.css') return route.fulfill({ contentType: 'text/css', body: '' });
    const files = new Set(['/static/app.js', '/static/inbox.js', '/static/app.css', '/static/personal-looks.css', '/static/assistant.css', '/static/notes.css', '/static/inbox.css', '/static/looks/minimalist/tokens.css', '/static/looks/minimalist/bundle.css']);
    if (files.has(url.pathname)) return route.fulfill({ contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css', body: source(url.pathname.slice('/static/'.length)) });
    if (url.pathname.startsWith('/api/')) requests.push({ path: url.pathname, method: req.method(), context: req.headers()['x-assistant-context'] });
    if (url.pathname === '/api/state') return json(familyState);
    if (url.pathname === '/api/assistant/status') return json(control.status);
    if (url.pathname === '/api/assistant/logout' && req.method() === 'POST') return json({ ok: true, context: 'b'.repeat(64) });
    if (url.pathname === '/api/assistant/state') {
      const pending = control.next; control.next = null;
      const result = pending ? await pending() : { body: clone(control.data), code: 200 };
      return json(result.body, result.code);
    }
    unexpected.push(url.pathname); return route.abort();
  });
  const page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(ORIGIN + '/' + hash);
  t.after(() => { assert.deepEqual(errors, [], 'unexpected browser script errors'); assert.deepEqual(unexpected, [], 'all network requests must be explicitly mocked'); });
  return { ...control, control, page, context, async ready() { await page.locator('.inbox-message').first().waitFor(); },
    async mainText() { return page.locator('#main').innerText(); } };
}

async function releaseAndSettle(page, held, body) {
  const response = page.waitForResponse((res) => res.url() === ORIGIN + '/api/assistant/state');
  held.release(body);
  await (await response).finished();
  // Let the real api() parse/check the response and its caller finish rendering.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
}

test('scoped mailbox, importance, search and drafts stay read-only', async (t) => {
  const f = await fixture(t); await f.ready();
  assert.equal(await f.page.locator('.inbox-message').count(), 2);
  assert.doesNotMatch(await f.mainText(), /OTHER PRIVATE|WRONG MAILBOX|Household booking/);
  await f.page.locator('[data-message-id="insurance"]').click();
  assert.match(await f.mainText(), /PRIVATE INSURANCE BODY/); assert.match(await f.mainText(), /Saved to workspace/);
  assert.equal(await f.page.locator('.inbox-reader a').count(), 0, 'no download or mail-action links');
  await f.page.getByLabel('Mailbox', { exact: true }).selectOption('outlook');
  assert.equal(await f.page.locator('.inbox-message').count(), 1); assert.doesNotMatch(await f.mainText(), /PRIVATE INSURANCE BODY/);
  await f.page.getByLabel('Mailbox', { exact: true }).selectOption('');
  await f.page.getByLabel('Important only').check();
  assert.equal(await f.page.locator('.inbox-message').count(), 1);
  await f.page.getByLabel('Search mail', { exact: true }).fill('missing');
  assert.equal(await f.page.locator('.inbox-message').count(), 0);
  await f.page.getByLabel('Search mail', { exact: true }).fill('');
  await f.page.getByLabel('Mail view', { exact: true }).selectOption('drafts');
  assert.equal(await f.page.getByLabel('Mailbox', { exact: true }).isDisabled(), true);
  await f.page.locator('[data-message-id="draft-private"]').click();
  assert.match(await f.mainText(), /UNSENT PRIVATE BODY/); assert.doesNotMatch(await f.mainText(), /UNSENT SHARED BODY/);
  await f.page.getByLabel('Inbox workspace', { exact: true }).selectOption('shared');
  assert.doesNotMatch(await f.mainText(), /UNSENT PRIVATE BODY|Private draft/);
  assert.equal(await f.page.locator('[data-message-id="draft-shared"]').count(), 1);
  assert.ok(f.requests.every((req) => req.method === 'GET'));
  assert.ok(f.requests.filter((req) => req.path.startsWith('/api/assistant/')).every((req) => req.context === CONTEXT));
});

test('mail and attachment text cannot create markup or executable attributes', async (t) => {
  const data = snapshot(); const payload = '<img src=x onerror="window.inboxXss=true">';
  Object.assign(data.emails[0], { subject: payload, sender: payload, body: payload });
  data.emails[0].attachments[0].name = payload;
  const f = await fixture(t, { data }); await f.ready();
  await f.page.locator('[data-message-id="insurance"]').click();
  assert.match(await f.mainText(), /<img src=x onerror=/);
  assert.equal(await f.page.locator('.inbox-view img, .inbox-view [onerror]').count(), 0);
  assert.equal(await f.page.evaluate(() => window.inboxXss), undefined);
});

test('another tab invalidates the old view before a delayed response can reveal mail', async (t) => {
  const f = await fixture(t); await f.ready();
  await f.page.locator('[data-message-id="insurance"]').click();
  const hold = await f.control.holdNextSnapshot();
  await f.page.getByRole('button', { name: 'Refresh', exact: true }).click(); await hold.started;
  const other = await f.context.newPage(); await other.goto(ORIGIN + '/notice');
  await other.evaluate(() => { const channel = new BroadcastChannel('family-hub-session'); channel.postMessage('changed'); channel.close(); });
  await f.page.getByRole('heading', { name: 'Your sign-in changed' }).waitFor();
  assert.doesNotMatch(await f.mainText(), /PRIVATE|Insurance renewal|Meeting details/);
  const changed = snapshot(); changed.user = { id: 'user-alex', name: 'Alex' }; changed.emails[0].subject = 'NEW ACCOUNT SECRET';
  await releaseAndSettle(f.page, hold, changed);
  await f.page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Your sign-in changed');
  assert.doesNotMatch(await f.mainText(), /NEW ACCOUNT SECRET|Alex|PRIVATE/);
  assert.deepEqual(await f.page.evaluate(() => cleared), { assistant: 1, notes: 1 });
});

test('a delayed Inbox response cannot overwrite another destination', async (t) => {
  const f = await fixture(t); await f.ready();
  const hold = await f.control.holdNextSnapshot();
  await f.page.getByRole('button', { name: 'Refresh', exact: true }).click(); await hold.started;
  await f.page.locator('a[href="#/photos"]').click();
  await f.page.getByRole('heading', { name: 'Photos', exact: true }).waitFor();
  await releaseAndSettle(f.page, hold);
  await f.page.waitForFunction(() => document.activeElement?.id === 'main');
  assert.equal(await f.page.locator('.inbox-view').count(), 0); assert.doesNotMatch(await f.mainText(), /PRIVATE|Insurance renewal/);
});

test('same-tab assistant disconnect clears the Inbox through the shared API lifecycle', async (t) => {
  const f = await fixture(t); await f.ready();
  await f.page.locator('[data-message-id="insurance"]').click();
  await f.page.evaluate(() => api('POST', '/api/assistant/logout', {}, undefined, { 'X-Assistant-Context': S.assistant_context }));
  await f.page.getByRole('heading', { name: 'Your sign-in changed' }).waitFor();
  assert.doesNotMatch(await f.mainText(), /PRIVATE|Insurance renewal|Meeting details/);
  assert.equal(await f.page.evaluate(() => cleared.notes), 1);
});

for (const code of [401, 409]) test(`authentication failure ${code} clears mail and both related views`, async (t) => {
  const f = await fixture(t); await f.ready();
  await f.page.locator('[data-message-id="insurance"]').click();
  f.control.next = async () => ({ code, body: { error: 'Sign-in changed', ...(code === 409 ? { code: 'assistant_session_changed' } : {}) } });
  await f.page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await f.page.getByRole('heading', { name: 'Your sign-in changed' }).waitFor();
  assert.doesNotMatch(await f.mainText(), /PRIVATE|Insurance renewal|Meeting details/);
  assert.deepEqual(await f.page.evaluate(() => cleared), { assistant: 1, notes: 1 });
});

test('unexpected owner change never renders the replacement account', async (t) => {
  const f = await fixture(t); await f.ready();
  f.control.data.user = { id: 'user-alex', name: 'OTHER ACCOUNT NAME' };
  f.control.data.emails[0].subject = 'OTHER ACCOUNT SECRET';
  await f.page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await f.page.getByRole('heading', { name: 'Your sign-in changed' }).waitFor();
  assert.doesNotMatch(await f.mainText(), /OTHER ACCOUNT|Insurance renewal|PRIVATE/);
});

test('keyboard selection and focused message survive refresh; offline state retains only current mail', async (t) => {
  const f = await fixture(t); await f.ready();
  const message = f.page.locator('[data-message-id="insurance"]');
  await message.focus(); await f.page.keyboard.press('Enter');
  assert.equal(await message.getAttribute('aria-current'), 'true');
  assert.equal(await f.page.evaluate(() => document.activeElement?.dataset.messageId), 'insurance');
  f.control.next = async () => ({ code: 503, body: { error: 'Offline' } });
  await f.page.evaluate(() => document.querySelector('.inbox-heading button').click());
  await f.page.getByText('Mail could not be refreshed. Showing the last successful view.').waitFor();
  assert.match(await f.mainText(), /PRIVATE INSURANCE BODY/);
  await f.page.evaluate(() => document.querySelector('.inbox-heading button').click());
  await f.page.waitForFunction(() => document.querySelector('.inbox-notice')?.textContent === '');
  assert.equal(await f.page.evaluate(() => document.activeElement?.dataset.messageId), 'insurance');
  f.control.data.emails = f.control.data.emails.filter((item) => item.id !== 'insurance');
  await f.page.evaluate(() => document.querySelector('.inbox-heading button').click());
  await f.page.locator('[data-message-id="insurance"]').waitFor({ state: 'detached' });
  assert.equal(await f.page.evaluate(() => document.activeElement?.className), 'inbox-messages');
  assert.doesNotMatch(await f.mainText(), /PRIVATE INSURANCE BODY/);
});

test('guest and admin-override entry cannot request assistant data', async (t) => {
  for (const profile of [{ guest: true }, { via_admin: true }]) {
    const f = await fixture(t, { profile, hash: '#/photos' });
    await f.page.getByRole('heading', { name: 'Photos', exact: true }).waitFor();
    if (profile.guest) assert.equal(await f.page.locator('#side a[href="#/inbox"]').count(), 0);
    await f.page.evaluate(() => InboxUI.page());
    await f.page.getByRole('heading', { name: 'Sign in as yourself' }).waitFor();
    assert.equal(f.requests.filter((req) => req.path.startsWith('/api/assistant/')).length, 0);
  }
});

test('small viewport retains named keyboard controls without horizontal overflow', async (t) => {
  const f = await fixture(t, { viewport: { width: 390, height: 844 } }); await f.ready();
  for (const label of ['Inbox workspace', 'Mailbox', 'Mail view', 'Search mail']) {
    const control = f.page.getByLabel(label, { exact: true });
    assert.equal(await control.isVisible(), true); await control.focus();
    assert.equal(await control.evaluate((node) => node === document.activeElement), true);
  }
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
});
