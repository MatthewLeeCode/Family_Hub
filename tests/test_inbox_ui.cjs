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
const { readFileSync, mkdirSync } = require('node:fs');
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

async function fixture(t, { profile = {}, status = {}, data = snapshot(), hash = '#/inbox', viewport, assistant = false } = {}) {
  const context = await browser.newContext({ ...(viewport ? { viewport } : {}), serviceWorkers: 'block' });
  t.after(async () => { await context.close(); });
  const requests = [], unexpected = [], errors = [];
  const control = {
    data,
    next: null,
    status: { configured: true, signed_in: true, user: data.user, ...status },
    previews: {}, runs: new Map(), mailHandler: null, chatHandler: null, revocation: 'not_connected', logoutWait: null,
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
    .replace('<script src="/static/assistant.js"></script>', assistant ? '<script src="/static/assistant.js"></script>' : '')
    .replace('<script src="/static/notes.js"></script>', '');
  await context.route('**/*', async (route) => {
    const req = route.request(); const url = new URL(req.url());
    if (url.origin !== ORIGIN) { unexpected.push(req.url()); return route.abort(); }
    const json = (body, code = 200) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname === '/notice') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Test notification sender</title>' });
    if (url.pathname === '/fixture/dependencies.js') return route.fulfill({ contentType: 'text/javascript', body:
      'window.cleared={assistant:0,notes:0}; ' + (assistant ? '' : 'const AssistantUI={leave(){},identity(){},page(){},sessionChanged(){cleared.assistant++;}}; ') + 'const NotesUI={leave(){},identity(){},page(){},sessionChanged(){cleared.notes++;}}; const SetPieces={transition(){}};' });
    if (url.pathname === '/fixture/empty.css') return route.fulfill({ contentType: 'text/css', body: '' });
    const files = new Set(['/static/app.js', '/static/inbox.js', '/static/mail-actions.js', '/static/assistant.js', '/static/app.css', '/static/personal-looks.css', '/static/assistant.css', '/static/notes.css', '/static/inbox.css', '/static/looks/minimalist/tokens.css', '/static/looks/minimalist/bundle.css']);
    if (files.has(url.pathname)) return route.fulfill({ contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css', body: source(url.pathname.slice('/static/'.length)) });
    if (url.pathname.startsWith('/api/')) requests.push({ path: url.pathname, method: req.method(), context: req.headers()['x-assistant-context'], body: req.postDataJSON() });
    if (url.pathname === '/api/state') return json(familyState);
    if (url.pathname === '/api/assistant/status') return json(control.status);
    if (url.pathname === '/api/assistant/logout' && req.method() === 'POST') {
      if (control.logoutWait) await control.logoutWait();
      return json({ ok: true, context: 'b'.repeat(64), core_revocation: control.revocation });
    }
    if (url.pathname === '/api/logout' && req.method() === 'POST') return json({ ok: true, core_revocation: control.revocation });
    if (url.pathname === '/api/assistant/login' && req.method() === 'POST') return json({ error: 'Sign-in failed', context: 'b'.repeat(64), core_revocation: control.revocation }, 401);
    if (url.pathname.startsWith('/api/assistant/mail/')) {
      if (control.mailHandler && await control.mailHandler({ route, req, url, json })) return;
      const preview = url.pathname.match(/^\/api\/assistant\/mail\/([^/]+)\/draft-intent$/);
      if (preview) {
        const message = control.data.emails.find((row) => row.id === preview[1]);
        if (!message) return json({ error: 'Not available', code: 'not_found' }, 404);
        return json(control.previews[message.id] || { kind: 'mail.local_draft.v1', message_id: message.id, space_id: message.space_id,
          source_digest: 'c'.repeat(64), source: { sender: message.sender, address: message.address, subject: message.subject,
            body: message.body, mailbox_id: message.mailbox_id, received_at: message.received_at }, effect: 'local_draft_only', can_request: true, eligibility: 'allowed' });
      }
      const lookup = url.pathname.match(/^\/api\/assistant\/mail\/draft-runs\/([^/]+)$/);
      if (lookup) return control.runs.has(lookup[1]) ? json(control.runs.get(lookup[1])) : json({ error: 'Not found', code: 'not_found' }, 404);
      const submit = url.pathname.match(/^\/api\/assistant\/mail\/([^/]+)\/draft-runs$/);
      if (submit) {
        const id = req.postDataJSON().request_id, message = control.data.emails.find((row) => row.id === submit[1]);
        if (!control.runs.has(id)) control.runs.set(id, { request_id: id, message_id: message.id, space_id: message.space_id,
          conversation_id: 'conversation-exact', job_id: 'job-exact', status: 'queued', draft_id: null, outcome_code: null, expires_at: Date.now() + 900000 });
        return json(control.runs.get(id), 202);
      }
    }
    const chat = url.pathname.match(/^\/api\/assistant\/conversations\/([^/]+)$/);
    if (chat) {
      if (control.chatHandler && await control.chatHandler({ id: chat[1], json })) return;
      return json({ conversation: control.data.conversations?.find((row) => row.id === chat[1]), messages: [], active_job: null, approvals: [] });
    }
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

test('scoped browsing and preview never create a draft without a request', async (t) => {
  const f = await fixture(t); await f.ready();
  assert.equal(await f.page.locator('.inbox-message').count(), 2);
  assert.doesNotMatch(await f.mainText(), /OTHER PRIVATE|WRONG MAILBOX|Household booking/);
  await f.page.locator('[data-message-id="insurance"]').click();
  await f.page.getByRole('button', { name: 'Draft reply', exact: true }).waitFor();
  await f.page.getByText('PRIVATE INSURANCE BODY', { exact: true }).waitFor();
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

async function selectForDraft(f, message = 'insurance') {
  await f.page.locator(`[data-message-id="${message}"]`).click();
  await f.page.getByRole('button', { name: 'Draft reply', exact: true }).waitFor();
  await f.page.waitForFunction(() => !document.querySelector('.inbox-draft-buttons button')?.disabled);
}
const posts = (f) => f.requests.filter((row) => row.method === 'POST' && row.path.endsWith('/draft-runs'));
const firstRun = (f) => Array.from(f.control.runs.values())[0];

test('Draft reply uses the authoritative displayed source and exact digest with no extra authority fields', async (t) => {
  const f = await fixture(t); await f.ready();
  f.control.previews.insurance = { kind: 'mail.local_draft.v1', message_id: 'insurance', space_id: 'private', source_digest: 'd'.repeat(64),
    source: { sender: 'Verified sender', address: 'verified@example.test', subject: 'Current source', body: 'CURRENT AUTHORITATIVE BODY', mailbox_id: 'gmail', received_at: 1700000000000 },
    effect: 'local_draft_only', can_request: true, eligibility: 'allowed' };
  await selectForDraft(f);
  assert.match(await f.mainText(), /CURRENT AUTHORITATIVE BODY/); assert.doesNotMatch(await f.mainText(), /PRIVATE INSURANCE BODY/);
  await f.page.getByRole('button', { name: 'Draft reply', exact: true }).dblclick();
  await f.page.getByText('Queued', { exact: true }).waitFor();
  assert.equal(posts(f).length, 1);
  assert.deepEqual(Object.keys(posts(f)[0].body).sort(), ['expected_source_digest', 'request_id']);
  assert.equal(posts(f)[0].body.expected_source_digest, 'd'.repeat(64));
  assert.match(posts(f)[0].body.request_id, /^[a-f0-9-]{36}$/);
  assert.equal(await f.page.getByRole('link', { name: 'Open request in Chat' }).getAttribute('href'), '#/assistant/conversation/conversation-exact');
  const storage = await f.page.evaluate(() => sessionStorage.getItem('family-hub-mail-requests-v1'));
  assert.match(storage, /user-matt/); assert.doesNotMatch(storage, /CURRENT AUTHORITATIVE|verified@example|Current source|token|password/i);
});

test('lost POST response reconciles the same request without another admission', async (t) => {
  const f = await fixture(t); await f.ready();
  f.control.mailHandler = async ({ req, url, route }) => {
    if (req.method() !== 'POST' || !url.pathname.endsWith('/draft-runs')) return false;
    const id = req.postDataJSON().request_id;
    f.control.runs.set(id, { request_id: id, message_id: 'insurance', space_id: 'private', conversation_id: 'saved-conversation', job_id: 'saved-job',
      status: 'running', draft_id: null, outcome_code: null, expires_at: Date.now() + 900000 });
    await route.abort('failed'); return true;
  };
  await selectForDraft(f); await f.page.getByRole('button', { name: 'Draft reply', exact: true }).click();
  await f.page.getByText('Preparing your draft', { exact: true }).waitFor();
  assert.equal(posts(f).length, 1);
  assert.ok(f.requests.some((row) => row.method === 'GET' && row.path.endsWith(posts(f)[0].body.request_id)));
  assert.equal(await f.page.getByRole('link', { name: 'Open request in Chat' }).getAttribute('href'), '#/assistant/conversation/saved-conversation');
  await f.page.reload(); await f.ready(); await f.page.locator('[data-message-id="insurance"]').click();
  await f.page.getByText('Preparing your draft', { exact: true }).waitFor();
  assert.equal(posts(f).length, 1, 'refresh recovery is read-only');
});

test('unconfirmed request with no result permits only deliberate retry of the immutable UUID and digest', async (t) => {
  const f = await fixture(t); await f.ready(); let attempts = 0;
  f.control.mailHandler = async ({ req, url, route }) => {
    if (req.method() === 'POST' && url.pathname.endsWith('/draft-runs') && attempts++ === 0) { await route.abort('failed'); return true; }
    return false;
  };
  await selectForDraft(f); await f.page.getByRole('button', { name: 'Draft reply', exact: true }).click();
  await f.page.getByRole('button', { name: 'Retry same request' }).waitFor();
  assert.equal(posts(f).length, 1);
  await f.page.getByRole('button', { name: 'Retry same request' }).click(); await f.page.getByText('Queued', { exact: true }).waitFor();
  assert.equal(posts(f).length, 2); assert.deepEqual(posts(f)[0].body, posts(f)[1].body);
});

test('outcome_unknown blocks a replacement request and retains the recorded reference', async (t) => {
  const f = await fixture(t); await f.ready(); await selectForDraft(f);
  await f.page.getByRole('button', { name: 'Draft reply', exact: true }).click(); await f.page.getByText('Queued', { exact: true }).waitFor();
  Object.assign(firstRun(f), { status: 'outcome_unknown', outcome_code: 'outcome_unknown' });
  await f.page.getByRole('button', { name: 'Check request status' }).click();
  await f.page.getByText(/An effect may have happened/).waitFor();
  assert.equal(await f.page.getByRole('button', { name: 'Review message for a new request' }).count(), 0);
  assert.equal(await f.page.getByRole('button', { name: 'Retry same request' }).count(), 0);
  assert.equal(posts(f).length, 1);
});

test('completed result opens the host-correlated draft rather than the newest draft', async (t) => {
  const f = await fixture(t); await f.ready(); await selectForDraft(f);
  await f.page.getByRole('button', { name: 'Draft reply', exact: true }).click(); await f.page.getByText('Queued', { exact: true }).waitFor();
  f.control.data.drafts.push({ id: 'unrelated-newest', space_id: 'private', subject: 'UNRELATED NEWER DRAFT', body: 'WRONG DRAFT BODY', recipient: 'other@example.test', received_at: Date.now() });
  Object.assign(firstRun(f), { status: 'completed', outcome_code: 'draft_created', draft_id: 'draft-private' });
  await f.page.getByRole('button', { name: 'Check request status' }).click(); await f.page.getByRole('button', { name: 'View local draft' }).click();
  await f.page.getByText('UNSENT PRIVATE BODY', { exact: true }).waitFor();
  assert.equal(await f.page.locator('[data-message-id="draft-private"]').getAttribute('aria-current'), 'true');
  assert.doesNotMatch(await f.page.locator('.inbox-reader').innerText(), /WRONG DRAFT BODY/);
});

test('current policy controls action availability while shared requests keep exact workspace identity', async (t) => {
  const f = await fixture(t); await f.ready();
  f.control.mailHandler = async ({ url, json }) => {
    if (!url.pathname.endsWith('/insurance/draft-intent')) return false;
    const row = f.control.data.emails[0];
    await json({ kind: 'mail.local_draft.v1', message_id: row.id, space_id: row.space_id, source_digest: 'a'.repeat(64), source: row,
      effect: 'local_draft_only', can_request: false, eligibility: 'denied' }); return true;
  };
  await f.page.locator('[data-message-id="insurance"]').click();
  await f.page.getByText('Your permissions do not allow drafting this reply.').waitFor();
  assert.equal(await f.page.getByRole('button', { name: 'Draft reply', exact: true }).isDisabled(), true); assert.equal(posts(f).length, 0);
  await f.page.getByLabel('Inbox workspace', { exact: true }).selectOption('shared'); await selectForDraft(f, 'family-message');
  await f.page.getByRole('button', { name: 'Draft reply', exact: true }).click(); await f.page.getByText('Queued', { exact: true }).waitFor();
  assert.equal(firstRun(f).space_id, 'shared'); assert.equal(posts(f)[0].path, '/api/assistant/mail/family-message/draft-runs');
});

test('delayed source preview cannot disclose or submit after workspace changes', async (t) => {
  const f = await fixture(t); await f.ready(); let release, started;
  const began = new Promise((resolve) => { started = resolve; }), wait = new Promise((resolve) => { release = resolve; });
  f.control.mailHandler = async ({ url, json }) => {
    if (!url.pathname.endsWith('/insurance/draft-intent')) return false;
    started(); await wait;
    const row = f.control.data.emails[0];
    await json({ kind: 'mail.local_draft.v1', message_id: row.id, space_id: row.space_id, source_digest: 'a'.repeat(64), source: { ...row, body: 'LATE PRIVATE SOURCE' }, effect: 'local_draft_only', can_request: true, eligibility: 'allowed' }); return true;
  };
  await f.page.locator('[data-message-id="insurance"]').click(); await began;
  await f.page.getByLabel('Inbox workspace', { exact: true }).selectOption('shared');
  release(); await f.page.getByText('Choose a message to read it.').waitFor();
  await f.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  assert.doesNotMatch(await f.mainText(), /LATE PRIVATE SOURCE|PRIVATE INSURANCE/); assert.equal(posts(f).length, 0);
});

test('cross-tab identity change clears saved request references and ignores an admitted late result', async (t) => {
  const f = await fixture(t); await f.ready(); let release, started;
  const began = new Promise((resolve) => { started = resolve; }), wait = new Promise((resolve) => { release = resolve; });
  f.control.mailHandler = async ({ req, url, json }) => {
    if (req.method() !== 'POST' || !url.pathname.endsWith('/draft-runs')) return false;
    started(); await wait;
    await json({ request_id: req.postDataJSON().request_id, message_id: 'insurance', space_id: 'private', conversation_id: 'LATE-SECRET-CONVERSATION', job_id: 'job', status: 'queued', draft_id: null, outcome_code: null, expires_at: Date.now() + 900000 }); return true;
  };
  await selectForDraft(f); await f.page.getByRole('button', { name: 'Draft reply', exact: true }).click(); await began;
  const other = await f.context.newPage(); await other.goto(ORIGIN + '/notice');
  await other.evaluate(() => { const c = new BroadcastChannel('family-hub-session'); c.postMessage('changed'); c.close(); });
  await f.page.getByRole('heading', { name: 'Your sign-in changed' }).waitFor(); release();
  assert.equal(await f.page.evaluate(() => sessionStorage.getItem('family-hub-mail-requests-v1')), null);
  assert.doesNotMatch(await f.mainText(), /PRIVATE|SECRET|Queued/);
});

test('waiting approval links to the exact authorized shared conversation through the real Chat controller', async (t) => {
  const data = snapshot(); data.user.private_space = 'private';
  data.conversations = [{ id: 'newer-private', space_id: 'private', title: 'Other conversation', updated_at: 99 },
    { id: 'conversation-exact', space_id: 'shared', title: 'Selected mail request', updated_at: 1 }];
  const f = await fixture(t, { data, assistant: true }); await f.ready();
  f.control.previews['family-message'] = { kind: 'mail.local_draft.v1', message_id: 'family-message', space_id: 'shared', source_digest: 'e'.repeat(64),
    source: data.emails.find((row) => row.id === 'family-message'), effect: 'local_draft_only', can_request: true, eligibility: 'approval_required' };
  await f.page.getByLabel('Inbox workspace', { exact: true }).selectOption('shared'); await selectForDraft(f, 'family-message');
  await f.page.getByText('You will review the exact action in Chat before it runs.').waitFor();
  await f.page.getByRole('button', { name: 'Draft reply', exact: true }).click(); await f.page.getByText('Queued', { exact: true }).waitFor();
  Object.assign(firstRun(f), { status: 'waiting_approval' });
  await f.page.getByRole('button', { name: 'Check request status' }).click();
  await f.page.getByRole('link', { name: 'Review permission in Chat' }).click();
  await f.page.getByRole('heading', { name: 'Selected mail request', exact: true }).waitFor();
  assert.equal(await f.page.getByLabel('Assistant workspace', { exact: true }).inputValue(), 'shared');
  assert.ok(f.requests.some((row) => row.path === '/api/assistant/conversations/conversation-exact'));
  assert.ok(!f.requests.some((row) => row.path === '/api/assistant/conversations/newer-private'));
});

for (const url of ['/api/assistant/logout', '/api/logout', '/api/assistant/login']) test(`unconfirmed ${url} keeps an honest disconnection notice`, async (t) => {
  const f = await fixture(t); await f.ready(); f.control.revocation = 'unconfirmed';
  await f.page.evaluate(async (path) => {
    try { await api('POST', path, {}, undefined, { 'X-Assistant-Context': S.assistant_context }); } catch (_) { /* Failed login still has a disconnection result. */ }
  }, url);
  await f.page.getByText('Previous assistant disconnection was not confirmed').waitFor();
  assert.match(await f.page.locator('#core-disconnect-notice').innerText(), /may still run until its original expiry/);
  assert.match(await f.page.locator('#core-disconnect-notice').innerText(), /does not mean all background work has stopped/);
  await f.page.getByRole('button', { name: 'Dismiss notice' }).click();
  assert.equal(await f.page.locator('#core-disconnect-notice').count(), 0);
});

test('changed-source rejection requires a new review and never automatically retries', async (t) => {
  const f = await fixture(t); await f.ready();
  f.control.mailHandler = async ({ req, url, json }) => {
    if (req.method() === 'POST' && url.pathname.endsWith('/draft-runs')) {
      await json({ error: 'Message changed. Review again.', code: 'source_changed' }, 409); return true;
    }
    return false;
  };
  await selectForDraft(f); await f.page.getByRole('button', { name: 'Draft reply', exact: true }).click();
  await f.page.getByText('Message changed. Review again.').waitFor();
  assert.equal(posts(f).length, 1); assert.equal(await f.page.getByRole('button', { name: 'Retry same request' }).count(), 0);
  f.control.data.emails[0].body = 'REVISED BODY FOR REVIEW';
  await f.page.getByRole('button', { name: 'Review message for a new request' }).click();
  await f.page.getByText('REVISED BODY FOR REVIEW', { exact: true }).waitFor();
  assert.equal(posts(f).length, 1, 'review alone does not request another draft');
});

test('mismatched source and result scopes fail closed without rendering foreign contents', async (t) => {
  const f = await fixture(t); await f.ready();
  f.control.mailHandler = async ({ url, json }) => {
    if (!url.pathname.endsWith('/insurance/draft-intent')) return false;
    await json({ kind: 'mail.local_draft.v1', message_id: 'insurance', space_id: 'shared', source_digest: 'a'.repeat(64),
      source: { sender: 'OTHER SECRET SENDER', address: 'x@test.invalid', subject: 'OTHER SECRET SUBJECT', body: 'OTHER SECRET BODY', mailbox_id: 'family', received_at: 0 },
      effect: 'local_draft_only', can_request: true, eligibility: 'allowed' }); return true;
  };
  await f.page.locator('[data-message-id="insurance"]').click();
  await f.page.getByText('The current message could not be verified.').waitFor();
  assert.doesNotMatch(await f.mainText(), /OTHER SECRET/); assert.equal(await f.page.getByRole('button', { name: 'Draft reply', exact: true }).isDisabled(), true);
  f.control.mailHandler = null;
  await f.page.getByRole('button', { name: 'Refresh message' }).click(); await f.page.getByText('PRIVATE INSURANCE BODY', { exact: true }).waitFor();
  await f.page.getByRole('button', { name: 'Draft reply', exact: true }).click(); await f.page.getByText('Queued', { exact: true }).waitFor();
  Object.assign(firstRun(f), { space_id: 'shared', conversation_id: 'foreign-conversation' });
  await f.page.getByRole('button', { name: 'Check request status' }).click(); await f.page.getByText(/outcome cannot be checked/).waitFor();
  assert.equal(await f.page.locator('a[href*="foreign-conversation"]').count(), 0);
  assert.equal(await f.page.getByRole('button', { name: 'Review message for a new request' }).count(), 0);
});

test('unavailable conversation deep link never opens a different recent chat', async (t) => {
  const data = snapshot(); data.user.private_space = 'private'; data.conversations = [{ id: 'recent-other', space_id: 'private', title: 'Wrong chat', updated_at: 99 }];
  const f = await fixture(t, { data, assistant: true, hash: '#/assistant/conversation/missing' });
  await f.page.getByRole('heading', { name: 'Conversation unavailable' }).waitFor();
  assert.ok(!f.requests.some((row) => row.path.includes('/conversations/')));
  assert.doesNotMatch(await f.mainText(), /Wrong chat/);
});

test('draft controls retain keyboard focus and fit every theme and a narrow viewport', async (t) => {
  const f = await fixture(t); await f.ready(); await selectForDraft(f);
  await f.page.getByRole('button', { name: 'Draft reply', exact: true }).click(); await f.page.getByText('Queued', { exact: true }).waitFor();
  const status = f.page.getByRole('button', { name: 'Check request status' });
  await status.focus(); await f.page.keyboard.press('Enter');
  await f.page.waitForFunction(() => document.activeElement?.dataset.mailFocus === 'status' && !document.activeElement.disabled);
  const output = path.resolve(__dirname, '../.test-runs/selected-mail-ui'); mkdirSync(output, { recursive: true });
  for (const theme of ['dark', 'light', 'paper', 'blueprint']) {
    await f.page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await f.page.screenshot({ path: path.join(output, theme + '.png'), fullPage: true });
  }
  await f.page.setViewportSize({ width: 390, height: 844 });
  await f.page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await f.page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
});

test('invalid stored rows do not discard the valid pending request reference on reload', async (t) => {
  const f = await fixture(t); await f.ready(); await selectForDraft(f);
  await f.page.getByRole('button', { name: 'Draft reply', exact: true }).click(); await f.page.getByText('Queued', { exact: true }).waitFor();
  const original = posts(f)[0].body.request_id;
  await f.page.evaluate(() => {
    const key = 'family-hub-mail-requests-v1', value = JSON.parse(sessionStorage.getItem(key));
    value.requests.push(null, 2, {}, { ...value.requests[0], request_id: 'dddddddd-dddd-4ddd-addd-dddddddddddd', created_at: Date.now() + 86400000 });
    sessionStorage.setItem(key, JSON.stringify(value));
  });
  await f.page.reload(); await f.ready(); await f.page.locator('[data-message-id="insurance"]').click();
  await f.page.getByText('Queued', { exact: true }).waitFor();
  assert.equal(posts(f).length, 1);
  assert.match(await f.page.locator('.inbox-request-ref').innerText(), new RegExp(original));
  assert.equal(await f.page.evaluate(() => JSON.parse(sessionStorage.getItem('family-hub-mail-requests-v1')).requests.length), 1);
});

test('a malformed terminal result cannot unlock a new request or claim a created draft', async (t) => {
  const f = await fixture(t); await f.ready(); await selectForDraft(f);
  await f.page.getByRole('button', { name: 'Draft reply', exact: true }).click(); await f.page.getByText('Queued', { exact: true }).waitFor();
  Object.assign(firstRun(f), { status: 'failed', outcome_code: null });
  await f.page.getByRole('button', { name: 'Check request status' }).click(); await f.page.getByText(/outcome cannot be checked/).waitFor();
  assert.equal(await f.page.getByRole('button', { name: 'Review message for a new request' }).count(), 0);
  assert.equal(await f.page.getByRole('button', { name: 'View local draft' }).count(), 0);
  assert.equal(posts(f).length, 1);
});

test('unconfirmed disconnection is still visible after navigation while its response was pending', async (t) => {
  const f = await fixture(t); await f.ready(); f.control.revocation = 'unconfirmed'; let release, started;
  const began = new Promise((resolve) => { started = resolve; }), wait = new Promise((resolve) => { release = resolve; });
  f.control.logoutWait = async () => { started(); await wait; };
  await f.page.evaluate(() => { window.pendingLogout = api('POST', '/api/assistant/logout', {}, undefined, { 'X-Assistant-Context': S.assistant_context }).catch(() => null); });
  await began;
  await f.page.locator('a[href="#/photos"]').click(); await f.page.getByRole('heading', { name: 'Photos', exact: true }).waitFor();
  release(); await f.page.evaluate(() => window.pendingLogout);
  await f.page.getByText('Previous assistant disconnection was not confirmed').waitFor();
  assert.match(await f.mainText(), /Photos/i); assert.equal(await f.page.locator('.inbox-view').count(), 0);
});

test('unresolved references older than 24 hours remain recoverable instead of creating a new request', async (t) => {
  const f = await fixture(t); await f.ready(); await selectForDraft(f);
  await f.page.getByRole('button', { name: 'Draft reply', exact: true }).click(); await f.page.getByText('Queued', { exact: true }).waitFor();
  const id = posts(f)[0].body.request_id;
  await f.page.evaluate(() => {
    const key = 'family-hub-mail-requests-v1', value = JSON.parse(sessionStorage.getItem(key));
    value.requests[0].created_at = Date.now() - 2 * 86400000; value.requests[0].settled = false;
    sessionStorage.setItem(key, JSON.stringify(value));
  });
  Object.assign(firstRun(f), { status: 'completed', outcome_code: 'draft_created', draft_id: 'draft-private' });
  await f.page.reload(); await f.ready(); await f.page.locator('[data-message-id="insurance"]').click();
  await f.page.getByText('Local draft created', { exact: true }).waitFor();
  assert.equal(posts(f).length, 1); assert.match(await f.page.locator('.inbox-request-ref').innerText(), new RegExp(id));
});

test('20 retained requests block fresh admission without silently evicting unresolved references', async (t) => {
  const f = await fixture(t); await f.ready();
  await f.page.evaluate(({ context }) => {
    const requests = Array.from({ length: 20 }, (_, index) => ({ request_id: crypto.randomUUID(), message_id: 'pending-' + index, space_id: 'private',
      expected_source_digest: 'c'.repeat(64), created_at: Date.now() - 2 * 86400000, settled: false }));
    sessionStorage.setItem('family-hub-mail-requests-v1', JSON.stringify({ context, owner: 'user-matt', requests }));
  }, { context: CONTEXT });
  const before = await f.page.evaluate(() => JSON.parse(sessionStorage.getItem('family-hub-mail-requests-v1')).requests.map((row) => row.request_id));
  await f.page.locator('[data-message-id="insurance"]').click();
  await f.page.getByText(/already retains 20 draft requests/).waitFor();
  assert.equal(await f.page.getByRole('button', { name: 'Draft reply', exact: true }).isDisabled(), true);
  assert.equal(posts(f).length, 0);
  assert.deepEqual(await f.page.evaluate(() => JSON.parse(sessionStorage.getItem('family-hub-mail-requests-v1')).requests.map((row) => row.request_id)), before);
});

test('a deep-link target disappearing after snapshot lookup never falls back to another recent chat', async (t) => {
  const data = snapshot(); data.user.private_space = 'private';
  data.conversations = [{ id: 'requested', space_id: 'private', title: 'Requested chat', updated_at: 1 }, { id: 'recent-other', space_id: 'private', title: 'Wrong chat', updated_at: 99 }];
  const f = await fixture(t, { data, assistant: true, hash: '#/inbox' }); await f.ready();
  f.control.chatHandler = async ({ id, json }) => {
    if (id !== 'requested') return false;
    f.control.data.conversations = f.control.data.conversations.filter((row) => row.id !== 'requested');
    await json({ error: 'Conversation is no longer available' }, 404); return true;
  };
  await f.page.evaluate(() => { location.hash = '#/assistant/conversation/requested'; });
  await f.page.getByRole('heading', { name: 'Conversation unavailable' }).waitFor();
  assert.ok(f.requests.some((row) => row.path === '/api/assistant/conversations/requested'));
  assert.ok(!f.requests.some((row) => row.path === '/api/assistant/conversations/recent-other'));
  assert.doesNotMatch(await f.mainText(), /Wrong chat/);
});
