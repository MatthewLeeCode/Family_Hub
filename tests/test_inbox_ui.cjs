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
    previews: {}, runs: new Map(), mailHandler: null, chatHandler: null, backgroundHandler: null, reviewHandler: null, revocation: 'not_connected', logoutWait: null,
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
    const resumeReview = url.pathname.match(/^\/api\/assistant\/responsibilities\/([^/]+)\/resume-review$/);
    if (resumeReview && req.method() === 'GET') {
      if (control.reviewHandler && await control.reviewHandler({ route, req, url, json })) return;
      const row = control.data.responsibilities.find((item) => item.id === resumeReview[1] && item.space_id === url.searchParams.get('space_id'));
      if (!row) return json({ error: 'Follow-up unavailable', code: 'not_found' }, 404);
      return json(reviewOf(row));
    }
    if (/^\/api\/assistant\/(responsibilities|approvals)\/[^/]+$/.test(url.pathname) && req.method() === 'POST') {
      if (control.backgroundHandler && await control.backgroundHandler({ route, req, url, json })) return;
      return json({ ok: true });
    }
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

test('navigation keeps Media routes and visible keyboard focus without an active side stripe', async (t) => {
  const f = await fixture(t);
  const media = f.page.locator('#side').getByRole('link', { name: 'Media', exact: true });
  assert.equal(await media.getAttribute('href'), '#/movies');
  assert.equal(await f.page.getByRole('link', { name: 'Movies and TV Shows', exact: true }).count(), 0);
  const current = f.page.locator('#side nav a[aria-current]');
  const output = path.resolve(__dirname, '../.test-runs/navigation-polish'); mkdirSync(output, { recursive: true });
  for (const layout of ['family', 'quiet', 'compact']) {
    for (const theme of ['dark', 'light', 'paper', 'blueprint']) {
      await f.page.evaluate(({ layout, theme }) => { Object.assign(document.documentElement.dataset, { layout, theme }); }, { layout, theme });
      assert.equal(await current.evaluate((node) => getComputedStyle(node).boxShadow), 'none');
      await f.page.keyboard.press('Tab');
      await media.focus();
      assert.deepEqual(await media.evaluate((node) => {
        const style = getComputedStyle(node);
        return [node.matches(':focus-visible'), style.outlineStyle, style.outlineWidth];
      }), [true, 'solid', '2px']);
    }
    await f.page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await f.page.screenshot({ path: path.join(output, layout + '.png'), fullPage: true });
  }
  assert.equal(f.requests.filter((request) => request.method !== 'GET').length, 0);
});

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

function backgroundSnapshot() {
  const data = snapshot(); data.user.private_space = 'private';
  const followup = (title, space, status) => ({ id: title.toLowerCase().replaceAll(' ', '-'), space_id: space, owner_id: 'user-matt', title,
    instruction: 'Check synthetic inbox', reason: 'A bounded demo follow-up', stop_condition: 'After one check',
    status, next_check_at: Date.now() + 60000, expires_at: Date.now() + 3600000, remaining_checks: 1,
    revision: 1, event_kind: '', event_resource: '', dependency_state: 'legacy_unbound', availability: 'not_evaluated',
    block_reason: 'legacy_unbound', dependencies: [], next_probe_at: null, current_job: null,
    can_pause: status === 'active', can_cancel: true, can_review_resume: status === 'paused' });
  data.responsibilities = [followup('Private active follow-up', 'private', 'active'),
    followup('Private paused follow-up', 'private', 'paused'), followup('Shared follow-up', 'shared', 'active')];
  data.approvals = [{ id: 'approval-private', space_id: 'private', status: 'pending', capability: 'Private approval',
    arguments: '{"resource":"PRIVATE ARGUMENT"}', action_digest: 'a'.repeat(64), dependency_blocked: false, expires_at: Date.now() + 3600000 }];
  data.conversations = [{ id: 'private-chat', space_id: 'private', title: 'Private chat', updated_at: 1 },
    { id: 'shared-chat', space_id: 'shared', title: 'Shared chat', updated_at: 1 }];
  data.jobs = []; data.preferences = []; data.notices = [];
  return data;
}

test('Background clears old controls during a delayed workspace load and preserves quick chat drafts', async (t) => {
  const f = await fixture(t, { data: backgroundSnapshot(), assistant: true, hash: '#/assistant/background' });
  await f.page.getByRole('button', { name: 'Resume', exact: true }).waitFor();
  await f.page.getByRole('button', { name: 'Open quick chat', exact: true }).click();
  await f.page.locator('#assistant-quick').getByRole('heading', { name: 'Private chat', exact: true }).waitFor();
  await f.page.getByLabel('Message your assistant', { exact: true }).fill('PRIVATE UNSENT DRAFT');
  await f.page.evaluate(() => { window.oldBackgroundControls = [...document.querySelectorAll('#main [data-operation]')]; });
  const held = await f.control.holdNextSnapshot();
  await f.page.getByLabel('Assistant workspace', { exact: true }).selectOption('shared'); await held.started;
  assert.match(await f.mainText(), /Loading background work/);
  assert.doesNotMatch(await f.mainText(), /Private active|Private paused|PRIVATE ARGUMENT|Private approval/);
  assert.equal(await f.page.locator('#main [data-operation]').count(), 0);
  await f.page.evaluate(() => window.oldBackgroundControls.forEach((button) => button.click()));
  assert.equal(f.requests.filter((row) => row.method === 'POST').length, 0);
  await releaseAndSettle(f.page, held);
  await f.page.getByRole('heading', { name: 'Shared follow-up', exact: true }).waitFor();
  assert.equal(await f.page.getByRole('button', { name: 'Resume', exact: true }).count(), 0);
  assert.equal(await f.page.getByLabel('Quick chat workspace', { exact: true }).inputValue(), 'shared');
  assert.equal(await f.page.getByLabel('Message your assistant', { exact: true }).inputValue(), '');
  await f.page.evaluate(() => window.oldBackgroundControls.forEach((button) => button.click()));
  assert.equal(f.requests.filter((row) => row.method === 'POST').length, 0);
  await f.page.getByLabel('Quick chat workspace', { exact: true }).selectOption('private');
  await f.page.getByRole('button', { name: 'Resume', exact: true }).waitFor();
  assert.equal(await f.page.getByLabel('Message your assistant', { exact: true }).inputValue(), 'PRIVATE UNSENT DRAFT');
  assert.equal(await f.page.getByLabel('Assistant workspace', { exact: true }).inputValue(), 'private');
});

test('a delayed old Background snapshot cannot repopulate controls while the new scope is loading', async (t) => {
  const f = await fixture(t, { data: backgroundSnapshot(), assistant: true, hash: '#/assistant/background' });
  await f.page.getByRole('button', { name: 'Resume', exact: true }).waitFor();
  const old = await f.control.holdNextSnapshot(); await old.started; // The existing single poller starts this read.
  await f.page.getByLabel('Assistant workspace', { exact: true }).selectOption('shared');
  const fresh = await f.control.holdNextSnapshot();
  const stale = backgroundSnapshot(); stale.responsibilities.forEach((row) => { row.title = 'STALE RESPONSE ' + row.title; });
  await releaseAndSettle(f.page, old, stale); await fresh.started;
  assert.match(await f.mainText(), /Loading background work/);
  assert.doesNotMatch(await f.mainText(), /STALE RESPONSE|Private active|Private paused/);
  assert.equal(await f.page.locator('#main [data-operation]').count(), 0);
  await releaseAndSettle(f.page, fresh);
  await f.page.getByRole('heading', { name: 'Shared follow-up', exact: true }).waitFor();
  assert.doesNotMatch(await f.mainText(), /STALE RESPONSE|Private active|Private paused/);
  assert.equal(f.requests.filter((row) => row.method === 'POST').length, 0);
});

for (const responseCode of [200, 409]) {
  test('late Background control response ' + responseCode + ' cannot affect a different workspace', async (t) => {
    const f = await fixture(t, { data: backgroundSnapshot(), assistant: true, hash: '#/assistant/background' });
    await f.page.getByRole('button', { name: 'Resume', exact: true }).waitFor();
    let start, release;
    const started = new Promise((resolve) => { start = resolve; }), wait = new Promise((resolve) => { release = resolve; });
    f.control.backgroundHandler = async ({ json }) => { start(); await wait; await json(responseCode === 200 ? { ok: true } : { error: 'OLD PRIVATE CONTROL ERROR' }, responseCode); return true; };
    await f.page.getByRole('button', { name: 'Pause', exact: true }).click(); await started;
    await f.page.getByLabel('Assistant workspace', { exact: true }).selectOption('shared');
    await f.page.getByRole('heading', { name: 'Shared follow-up', exact: true }).waitFor();
    await f.page.getByLabel('Assistant workspace', { exact: true }).focus();
    const acknowledged = f.page.waitForResponse((response) => response.url().includes('/responsibilities/') && response.status() === responseCode);
    release(); await (await acknowledged).finished();
    await f.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    assert.doesNotMatch(await f.mainText(), /Saved\.|OLD PRIVATE CONTROL ERROR|Private active|Private paused/);
    assert.equal(await f.page.getByRole('button', { name: 'Pause', exact: true }).isEnabled(), true);
    assert.equal(await f.page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Assistant workspace');
    const actions = f.requests.filter((row) => row.method === 'POST');
    assert.equal(actions.length, 1); assert.deepEqual(actions[0].body, { status: 'paused', revision: 1 });
  });
}

test('a Background action completing after cross-tab sign-in invalidation cannot restore old controls', async (t) => {
  const f = await fixture(t, { data: backgroundSnapshot(), assistant: true, hash: '#/assistant/background' });
  await f.page.getByRole('button', { name: 'Resume', exact: true }).waitFor();
  let start, release;
  const started = new Promise((resolve) => { start = resolve; }), wait = new Promise((resolve) => { release = resolve; });
  f.control.backgroundHandler = async ({ json }) => { start(); await wait; await json({ ok: true }); return true; };
  await f.page.getByRole('button', { name: 'Resume', exact: true }).click(); await started;
  const other = await f.context.newPage(); await other.goto(ORIGIN + '/notice');
  await other.evaluate(() => { const channel = new BroadcastChannel('family-hub-session'); channel.postMessage('changed'); channel.close(); });
  await f.page.getByRole('heading', { name: 'Your sign-in changed' }).waitFor();
  const acknowledged = f.page.waitForResponse((response) => response.url().includes('/responsibilities/'));
  release(); await (await acknowledged).finished();
  await f.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  assert.doesNotMatch(await f.mainText(), /Saved\.|Private active|Private paused|PRIVATE ARGUMENT/);
  assert.equal(await f.page.locator('#main [data-operation]').count(), 0);
  assert.equal(f.requests.filter((row) => row.method === 'POST').length, 1);
});

test('Background ignores a returning old action and refreshes its pending control after a scope round trip', async (t) => {
  const f = await fixture(t, { data: backgroundSnapshot(), assistant: true, hash: '#/assistant/background' });
  await f.page.getByRole('button', { name: 'Resume', exact: true }).waitFor();
  let start, release;
  const started = new Promise((resolve) => { start = resolve; }), wait = new Promise((resolve) => { release = resolve; });
  f.control.backgroundHandler = async ({ json }) => { start(); await wait; await json({ error: 'STALE ROUND TRIP ERROR' }, 409); return true; };
  await f.page.getByRole('button', { name: 'Pause', exact: true }).click(); await started;
  await f.page.getByLabel('Assistant workspace', { exact: true }).selectOption('shared');
  await f.page.getByRole('heading', { name: 'Shared follow-up', exact: true }).waitFor();
  await f.page.getByLabel('Assistant workspace', { exact: true }).selectOption('private');
  await f.page.getByRole('heading', { name: 'Private active follow-up', exact: true }).waitFor();
  assert.equal(await f.page.getByRole('button', { name: 'Pause', exact: true }).isDisabled(), true);
  const acknowledged = f.page.waitForResponse((response) => response.url().includes('/responsibilities/'));
  release(); await (await acknowledged).finished();
  await f.page.waitForFunction(() => [...document.querySelectorAll('#main button')].some((button) => button.textContent === 'Pause' && !button.disabled));
  assert.doesNotMatch(await f.mainText(), /STALE ROUND TRIP ERROR|Saved\./);
  assert.equal(f.requests.filter((row) => row.method === 'POST').length, 1);
});

test('a delayed quick-chat read cannot redraw old Background data after a workspace change', async (t) => {
  const f = await fixture(t, { data: backgroundSnapshot(), assistant: true, hash: '#/assistant/background' });
  await f.page.getByRole('button', { name: 'Resume', exact: true }).waitFor();
  await f.page.getByRole('button', { name: 'Open quick chat', exact: true }).click();
  await f.page.locator('#assistant-quick').getByRole('heading', { name: 'Private chat', exact: true }).waitFor();
  let start, release;
  const started = new Promise((resolve) => { start = resolve; }), wait = new Promise((resolve) => { release = resolve; });
  f.control.chatHandler = async ({ id, json }) => {
    if (id !== 'private-chat') return false;
    start(); await wait;
    await json({ conversation: f.control.data.conversations[0], messages: [{ id: 'late', role: 'assistant', text: 'LATE PRIVATE CHAT', status: 'complete' }], active_job: null }); return true;
  };
  await started; // Polling has loaded its snapshot and is now waiting for chat.
  await f.page.getByLabel('Assistant workspace', { exact: true }).selectOption('shared');
  const fresh = await f.control.holdNextSnapshot();
  release(); await fresh.started;
  assert.match(await f.mainText(), /Loading background work/);
  assert.equal(await f.page.locator('#main [data-operation]').count(), 0);
  assert.doesNotMatch(await f.page.locator('body').innerText(), /Private active|Private paused|LATE PRIVATE CHAT/);
  await releaseAndSettle(f.page, fresh);
  await f.page.getByRole('heading', { name: 'Shared follow-up', exact: true }).waitFor();
  assert.doesNotMatch(await f.page.locator('body').innerText(), /LATE PRIVATE CHAT/);
});

for (const tab of ['memory', 'activity']) {
  test(tab + ' clears private text immediately while a shared-workspace read is delayed', async (t) => {
    const data = backgroundSnapshot();
    data.preferences = [{ id: 'private-preference', text: 'PRIVATE PREFERENCE TEXT', created_at: 1700000000000 }];
    data.notices = [{ id: 'private-notice', space_id: 'private', title: 'Private notice', body: 'PRIVATE ACTIVITY TEXT', created_at: 1700000000000 },
      { id: 'shared-notice', space_id: 'shared', title: 'Household notice', body: 'SHARED ACTIVITY TEXT', created_at: 1700000000000 }];
    const f = await fixture(t, { data, assistant: true, hash: '#/assistant/' + tab });
    await f.page.getByText(tab === 'memory' ? 'PRIVATE PREFERENCE TEXT' : 'PRIVATE ACTIVITY TEXT', { exact: true }).waitFor();
    const held = await f.control.holdNextSnapshot();
    await f.page.getByLabel('Assistant workspace', { exact: true }).selectOption('shared'); await held.started;
    assert.match(await f.mainText(), new RegExp('Loading ' + tab + ' for this workspace'));
    assert.doesNotMatch(await f.mainText(), /PRIVATE PREFERENCE TEXT|PRIVATE ACTIVITY TEXT|Private notice/);
    await releaseAndSettle(f.page, held);
    await f.page.getByText(tab === 'memory' ? 'Private memories appear only in your private workspace.' : 'SHARED ACTIVITY TEXT', { exact: true }).waitFor();
    assert.doesNotMatch(await f.mainText(), /PRIVATE PREFERENCE TEXT|PRIVATE ACTIVITY TEXT|Private notice/);
  });
}

function boundSnapshot() {
  const data = backgroundSnapshot();
  const row = data.responsibilities[1];
  Object.assign(row, { id: 'bound-followup', title: 'Bound inbox follow-up', dependency_state: 'bound', availability: 'blocked',
    block_reason: 'grant_changed', dependencies: [{ capability: 'mail.search', connection_id: null, availability: 'blocked', reason_code: 'grant_changed' }] });
  data.responsibilities = [row, data.responsibilities[2]];
  return data;
}

function reviewOf(row, changes = {}) {
  return { id: row.id, space_id: row.space_id, owner_id: row.owner_id, revision: row.revision, review_digest: 'd'.repeat(64),
    can_resume: true, block_reason: null, remaining_checks: row.remaining_checks, expires_at: row.expires_at, current_job: clone(row.current_job),
    dependencies: row.dependencies.map((dependency) => ({ ...dependency, availability: 'ready', reason_code: null,
      permission_mode: 'current_task', changes: ['grant_changed'] })), ...changes };
}
const followupPosts = (f) => f.requests.filter((row) => row.method === 'POST' && row.path.includes('/responsibilities/'));
const reviewGets = (f) => f.requests.filter((row) => row.path.endsWith('/resume-review'));

test('dependency review precedes exact owner Resume and retains the last charged job with zero checks', async (t) => {
  const data = boundSnapshot(), row = data.responsibilities[0]; row.remaining_checks = 0;
  row.current_job = { id: 'already-charged-job', status: 'waiting_dependency', block_reason: 'grant_changed' };
  const f = await fixture(t, { data, assistant: true, hash: '#/assistant/background' });
  await f.page.getByRole('button', { name: 'Review dependencies', exact: true }).waitFor();
  assert.equal(await f.page.getByRole('button', { name: 'Resume follow-up', exact: true }).count(), 0);
  assert.match(await f.mainText(), /0 checks left|already-charged check/);
  await f.page.getByRole('button', { name: 'Review dependencies', exact: true }).click();
  await f.page.getByRole('button', { name: 'Resume follow-up', exact: true }).waitFor();
  assert.match(await f.mainText(), /Verified current request|separate approval|continue where it stopped/);
  assert.equal(followupPosts(f).length, 0); assert.equal(reviewGets(f).length, 1);
  assert.equal(await f.page.evaluate(() => sessionStorage.length), 0);
  f.control.backgroundHandler = async ({ req, json }) => {
    assert.deepEqual(req.postDataJSON(), { status: 'active', revision: 1, dependency_review_digest: 'd'.repeat(64) });
    Object.assign(row, { status: 'active', revision: 2, availability: 'ready', block_reason: null, can_pause: true, can_review_resume: false,
      dependencies: [{ capability: 'mail.search', connection_id: null, availability: 'ready', reason_code: null }],
      current_job: { id: 'already-charged-job', status: 'queued', block_reason: null } });
    await json({ ok: true }); return true;
  };
  await f.page.getByRole('button', { name: 'Resume follow-up', exact: true }).click();
  await f.page.getByText('Follow-up updated.', { exact: true }).waitFor();
  assert.equal(followupPosts(f).length, 1); assert.equal(reviewGets(f).length, 1);
  assert.equal(row.current_job.id, 'already-charged-job'); assert.equal(row.remaining_checks, 0);
  assert.equal(await f.page.getByRole('button', { name: 'Pause', exact: true }).count(), 1);
});

test('dependency incomplete check stays visibly paused until the owner reviews and resumes', async (t) => {
  const data = boundSnapshot(), row = data.responsibilities[0];
  Object.assign(row, { block_reason: 'check_incomplete', next_check_at: null,
    dependencies: [{ capability: 'mail.search', connection_id: null, availability: 'ready', reason_code: null }] });
  const f = await fixture(t, { data, assistant: true, hash: '#/assistant/background' });
  const card = f.page.locator('[data-followup-id="bound-followup"]');
  await card.getByText('The last check ended without deciding what to do next. Review before resuming.', { exact: true }).waitFor();
  assert.match(await card.innerText(), /Paused/);
  assert.equal(await card.getByRole('button', { name: 'Resume follow-up', exact: true }).count(), 0);
  assert.equal(followupPosts(f).length, 0);
  f.control.reviewHandler = async ({ json }) => {
    await json(reviewOf(row, { dependencies: [{ ...row.dependencies[0], permission_mode: 'confirm', changes: [] }] })); return true;
  };
  await card.getByRole('button', { name: 'Review dependencies', exact: true }).click();
  await card.getByRole('button', { name: 'Resume follow-up', exact: true }).waitFor();
  assert.equal(reviewGets(f).length, 1); assert.equal(followupPosts(f).length, 0);
  f.control.backgroundHandler = async ({ req, json }) => {
    assert.deepEqual(req.postDataJSON(), { status: 'active', revision: 1, dependency_review_digest: 'd'.repeat(64) });
    Object.assign(row, { status: 'active', revision: 2, availability: 'ready', block_reason: null,
      next_check_at: Date.now() + 60000, can_pause: true, can_review_resume: false });
    await json({ ok: true }); return true;
  };
  await card.getByRole('button', { name: 'Resume follow-up', exact: true }).click();
  await f.page.getByText('Follow-up updated.', { exact: true }).waitFor();
  assert.equal(followupPosts(f).length, 1);
  assert.doesNotMatch(await card.innerText(), /last check ended without deciding/);
  assert.equal(await card.getByRole('button', { name: 'Pause', exact: true }).count(), 1);
});

test('legacy dependency labeling retains direct Resume without a review digest', async (t) => {
  const f = await fixture(t, { data: backgroundSnapshot(), assistant: true, hash: '#/assistant/background' });
  await f.page.getByRole('button', { name: 'Resume', exact: true }).waitFor();
  assert.match(await f.mainText(), /Dependencies not recorded/);
  await f.page.getByRole('button', { name: 'Resume', exact: true }).click();
  await f.page.getByText('Follow-up updated.', { exact: true }).waitFor();
  assert.equal(reviewGets(f).length, 0);
  assert.deepEqual(followupPosts(f)[0].body, { status: 'active', revision: 1 });
});

test('dependency waiting keeps original due time and permission requests separate', async (t) => {
  const data = boundSnapshot(), row = data.responsibilities[0];
  Object.assign(row, { status: 'active', availability: 'waiting', block_reason: 'connector_offline', can_pause: true, can_review_resume: false,
    next_probe_at: Date.now() + 30000, dependencies: [{ capability: 'mail.search', connection_id: 'mail-connector', availability: 'waiting', reason_code: 'connector_offline' }] });
  const f = await fixture(t, { data, assistant: true, hash: '#/assistant/background' });
  await f.page.getByText('Waiting for connection', { exact: true }).waitFor();
  await f.page.locator('[data-followup-id="bound-followup"] summary').click();
  assert.match(await f.mainText(), /Originally due:|Scheduler recheck:|does not reconnect|preserves its budget and pending events/);
  assert.equal(await f.page.getByRole('button', { name: 'Allow once', exact: true }).count(), 1);
  assert.equal(await f.page.getByRole('button', { name: 'Review dependencies', exact: true }).count(), 0);
});

test('an ineligible dependency review explains the blocker without enabling Resume or blocking approvals', async (t) => {
  const data = boundSnapshot(), row = data.responsibilities[0];
  const f = await fixture(t, { data, assistant: true, hash: '#/assistant/background' });
  await f.page.getByRole('button', { name: 'Review dependencies', exact: true }).waitFor();
  f.control.reviewHandler = async ({ json }) => {
    await json(reviewOf(row, { can_resume: false, review_digest: null, block_reason: 'grant_denied',
      dependencies: [{ capability: 'mail.search', connection_id: null, availability: 'blocked', reason_code: 'grant_denied', permission_mode: 'unavailable', changes: [] }] })); return true;
  };
  await f.page.getByRole('button', { name: 'Review dependencies', exact: true }).click();
  await f.page.getByRole('region', { name: 'Dependency review for Bound inbox follow-up' }).getByText('A required tool is blocked by your permissions.', { exact: true }).first().waitFor();
  assert.equal(await f.page.getByRole('button', { name: 'Resume follow-up', exact: true }).count(), 0);
  assert.equal(await f.page.getByRole('button', { name: 'Allow once', exact: true }).isEnabled(), true);
  assert.equal(followupPosts(f).length, 0);
});

test('a stale dependency review response is ignored after a workspace change', async (t) => {
  const data = boundSnapshot(), row = data.responsibilities[0];
  const f = await fixture(t, { data, assistant: true, hash: '#/assistant/background' });
  await f.page.getByRole('button', { name: 'Review dependencies', exact: true }).waitFor();
  let start, release;
  const started = new Promise((resolve) => { start = resolve; }), wait = new Promise((resolve) => { release = resolve; });
  f.control.reviewHandler = async ({ json, url }) => { assert.equal(url.searchParams.get('space_id'), 'private'); start(); await wait; await json(reviewOf(row)); return true; };
  await f.page.getByRole('button', { name: 'Review dependencies', exact: true }).click(); await started;
  await f.page.getByLabel('Assistant workspace', { exact: true }).selectOption('shared');
  await f.page.getByRole('heading', { name: 'Shared follow-up', exact: true }).waitFor();
  const response = f.page.waitForResponse((reply) => reply.url().includes('/resume-review'));
  release(); await (await response).finished(); await f.page.evaluate(() => new Promise(requestAnimationFrame));
  assert.doesNotMatch(await f.mainText(), /Current dependencies|Bound inbox follow-up|Verified current request/);
  assert.equal(await f.page.getByRole('button', { name: 'Resume follow-up', exact: true }).count(), 0);
  assert.equal(followupPosts(f).length, 0);
});

test('dependency review invalidates on a new revision without silently fetching or accepting another review', async (t) => {
  const data = boundSnapshot(), row = data.responsibilities[0];
  const f = await fixture(t, { data, assistant: true, hash: '#/assistant/background' });
  await f.page.getByRole('button', { name: 'Review dependencies', exact: true }).click();
  await f.page.getByRole('button', { name: 'Resume follow-up', exact: true }).waitFor();
  await f.page.evaluate(() => { window.oldResume = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Resume follow-up'); });
  row.revision++;
  await f.page.getByText('This follow-up changed. Review its current dependencies again.', { exact: true }).waitFor();
  await f.page.evaluate(() => window.oldResume.click());
  assert.equal(await f.page.getByRole('button', { name: 'Resume follow-up', exact: true }).count(), 0);
  assert.equal(reviewGets(f).length, 1); assert.equal(followupPosts(f).length, 0);
});

test('dependency expiry invalidates the displayed digest before a click even without a new snapshot', async (t) => {
  const data = boundSnapshot(), row = data.responsibilities[0];
  const f = await fixture(t, { data, assistant: true, hash: '#/assistant/background' });
  await f.page.getByRole('button', { name: 'Review dependencies', exact: true }).click();
  await f.page.getByRole('button', { name: 'Resume follow-up', exact: true }).waitFor();
  await f.page.evaluate((expired) => { Date.now = () => expired; }, row.expires_at + 1);
  await f.page.getByRole('button', { name: 'Resume follow-up', exact: true }).click();
  await f.page.getByText('This follow-up expired.', { exact: true }).waitFor();
  assert.equal(followupPosts(f).length, 0); assert.equal(reviewGets(f).length, 1);
});

test('dependency Resume lost response reconciles current state and never automatically repeats the action', async (t) => {
  const data = boundSnapshot(), row = data.responsibilities[0];
  const f = await fixture(t, { data, assistant: true, hash: '#/assistant/background' });
  await f.page.getByRole('button', { name: 'Review dependencies', exact: true }).click();
  await f.page.getByRole('button', { name: 'Resume follow-up', exact: true }).waitFor();
  f.control.backgroundHandler = async ({ route }) => {
    Object.assign(row, { status: 'active', revision: 2, availability: 'ready', block_reason: null, can_pause: true, can_review_resume: false,
      dependencies: [{ capability: 'mail.search', connection_id: null, availability: 'ready', reason_code: null }] });
    await route.abort('failed'); return true;
  };
  await f.page.getByRole('button', { name: 'Resume follow-up', exact: true }).click();
  await f.page.getByText(/The action was not confirmed. The current state is shown/).waitFor();
  assert.equal(await f.page.getByRole('button', { name: 'Pause', exact: true }).isEnabled(), true);
  assert.equal(await f.page.getByRole('button', { name: 'Resume follow-up', exact: true }).count(), 0);
  assert.equal(followupPosts(f).length, 1); assert.equal(reviewGets(f).length, 1);
});

test('dependency Resume conflict requires a fresh displayed review and never accepts changed authority automatically', async (t) => {
  const data = boundSnapshot(), row = data.responsibilities[0];
  const f = await fixture(t, { data, assistant: true, hash: '#/assistant/background' });
  await f.page.getByRole('button', { name: 'Review dependencies', exact: true }).click();
  await f.page.getByRole('button', { name: 'Resume follow-up', exact: true }).waitFor();
  f.control.backgroundHandler = async ({ json }) => { row.revision++; await json({ error: 'Dependencies changed. Review again.', code: 'dependency_review_changed' }, 409); return true; };
  await f.page.getByRole('button', { name: 'Resume follow-up', exact: true }).click();
  await f.page.getByText(/The action was not confirmed. The current state is shown/).waitFor();
  assert.equal(await f.page.getByRole('button', { name: 'Resume follow-up', exact: true }).count(), 0);
  assert.equal(reviewGets(f).length, 1); assert.equal(followupPosts(f).length, 1);
  await f.page.getByRole('button', { name: 'Review dependencies', exact: true }).click();
  await f.page.getByRole('button', { name: 'Resume follow-up', exact: true }).waitFor();
  assert.equal(reviewGets(f).length, 2); assert.equal(followupPosts(f).length, 1);
});

test('dependency controls obey non-owner and unknown-state flags rather than guessing readiness', async (t) => {
  const data = boundSnapshot(), row = data.responsibilities[0]; row.owner_id = 'user-nicky'; row.can_review_resume = false;
  const f = await fixture(t, { data, assistant: true, hash: '#/assistant/background' });
  await f.page.getByRole('heading', { name: 'Bound inbox follow-up', exact: true }).waitFor();
  assert.equal(await f.page.getByRole('button', { name: 'Review dependencies', exact: true }).count(), 0);
  assert.equal(await f.page.getByRole('button', { name: 'Cancel follow-up', exact: true }).count(), 1);
  row.availability = 'future-state';
  await f.page.getByRole('heading', { name: 'Background unavailable', exact: true }).waitFor();
  assert.equal(await f.page.locator('#main [data-operation]').count(), 0);
  assert.equal(followupPosts(f).length, 0);
});

test('dependency review remains escaped, keyboard reachable and usable across themes and a narrow viewport', async (t) => {
  const data = boundSnapshot(); data.responsibilities[0].title = '<img src=x onerror=window.bad=true>';
  const f = await fixture(t, { data, assistant: true, hash: '#/assistant/background' });
  await f.page.getByRole('button', { name: 'Review dependencies', exact: true }).focus();
  await f.page.keyboard.press('Enter');
  await f.page.getByRole('button', { name: 'Resume follow-up', exact: true }).waitFor();
  assert.equal(await f.page.evaluate(() => document.activeElement?.textContent), 'Resume follow-up');
  assert.equal(await f.page.locator('#main img, #main [onerror]').count(), 0);
  const output = path.resolve(__dirname, '../.test-runs/dependency-background'); mkdirSync(output, { recursive: true });
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

test('dependency review arriving after cross-tab identity invalidation never exposes its controls', async (t) => {
  const data = boundSnapshot(), row = data.responsibilities[0];
  const f = await fixture(t, { data, assistant: true, hash: '#/assistant/background' });
  await f.page.getByRole('button', { name: 'Review dependencies', exact: true }).waitFor();
  let start, release;
  const started = new Promise((resolve) => { start = resolve; }), wait = new Promise((resolve) => { release = resolve; });
  f.control.reviewHandler = async ({ json }) => { start(); await wait; await json(reviewOf(row)); return true; };
  await f.page.getByRole('button', { name: 'Review dependencies', exact: true }).click(); await started;
  const other = await f.context.newPage(); await other.goto(ORIGIN + '/notice');
  await other.evaluate(() => { const channel = new BroadcastChannel('family-hub-session'); channel.postMessage('changed'); channel.close(); });
  await f.page.getByRole('heading', { name: 'Your sign-in changed' }).waitFor();
  const response = f.page.waitForResponse((reply) => reply.url().includes('/resume-review'));
  release(); await (await response).finished(); await f.page.evaluate(() => new Promise(requestAnimationFrame));
  assert.doesNotMatch(await f.mainText(), /Bound inbox follow-up|Current dependencies|Verified current request/);
  assert.equal(await f.page.getByRole('button', { name: 'Resume follow-up', exact: true }).count(), 0);
  assert.equal(followupPosts(f).length, 0);
});

test('dependency review rejects mismatched authority without hiding the existing permission requests', async (t) => {
  const data = boundSnapshot(), row = data.responsibilities[0];
  const f = await fixture(t, { data, assistant: true, hash: '#/assistant/background' });
  await f.page.getByRole('button', { name: 'Review dependencies', exact: true }).waitFor();
  f.control.reviewHandler = async ({ json }) => { await json(reviewOf(row, { owner_id: 'another-account' })); return true; };
  await f.page.getByRole('button', { name: 'Review dependencies', exact: true }).click();
  await f.page.getByText('The dependency review could not be verified. Reload it before resuming.', { exact: true }).waitFor();
  assert.equal(await f.page.getByRole('button', { name: 'Resume follow-up', exact: true }).count(), 0);
  assert.equal(await f.page.getByRole('button', { name: 'Allow once', exact: true }).isEnabled(), true);
  assert.equal(followupPosts(f).length, 0);
});

test('dependency-blocked approval preserves identity arguments and deadline through recovery and rejects detached clicks', async (t) => {
  const data = backgroundSnapshot(), approval = data.approvals[0], deadline = approval.expires_at;
  const f = await fixture(t, { data, assistant: true, hash: '#/assistant/background' });
  await f.page.getByRole('button', { name: 'Allow once', exact: true }).waitFor();
  const card = f.page.locator('[data-approval-id="approval-private"]');
  const originalDeadline = await card.locator('p').filter({ hasText: /^Expires / }).innerText();
  await f.page.evaluate(() => { window.oldApprovalButtons = [...document.querySelectorAll('.assistant-approval button')]; });
  approval.dependency_blocked = true;
  await f.page.getByText('This check is paused or waiting for required tools. Review it in Background before deciding. The original expiry still applies.', { exact: true }).waitFor();
  assert.equal(await card.locator('button').count(), 0);
  assert.equal(await card.locator('p').filter({ hasText: /^Expires / }).innerText(), originalDeadline);
  assert.match(await card.innerText(), /PRIVATE ARGUMENT/);
  const output = path.resolve(__dirname, '../.test-runs/dependency-background'); mkdirSync(output, { recursive: true });
  await card.screenshot({ path: path.join(output, 'approval-waiting.png') });
  await f.page.evaluate(() => window.oldApprovalButtons.forEach((button) => button.click()));
  assert.equal(f.requests.filter((request) => request.method === 'POST').length, 0);
  approval.dependency_blocked = false;
  await f.page.getByRole('button', { name: 'Allow once', exact: true }).waitFor();
  assert.equal(await f.page.getByRole('button', { name: 'Deny', exact: true }).isEnabled(), true);
  assert.equal(approval.expires_at, deadline);
  assert.equal(await card.locator('p').filter({ hasText: /^Expires / }).innerText(), originalDeadline);
  await f.page.evaluate(() => window.oldApprovalButtons.forEach((button) => button.click()));
  assert.equal(f.requests.filter((request) => request.method === 'POST').length, 0);
});

test('dependency-blocked approval expiry never renews its deadline or makes Allow available after recovery', async (t) => {
  const data = backgroundSnapshot(), approval = data.approvals[0], deadline = approval.expires_at; approval.dependency_blocked = true;
  const f = await fixture(t, { data, assistant: true, hash: '#/assistant/background' });
  await f.page.getByText('This check is paused or waiting for required tools. Review it in Background before deciding. The original expiry still applies.', { exact: true }).waitFor();
  await f.page.evaluate((expired) => { Date.now = () => expired; }, deadline + 1);
  await f.page.getByText('This request can no longer be approved.', { exact: true }).waitFor();
  assert.equal(await f.page.locator('.assistant-approval button').count(), 0);
  assert.match(await f.page.locator('.assistant-approval').innerText(), /Expired |PRIVATE ARGUMENT/);
  approval.dependency_blocked = false;
  await f.page.getByRole('button', { name: 'Deny', exact: true }).waitFor();
  assert.equal(await f.page.getByRole('button', { name: 'Allow once', exact: true }).count(), 0);
  assert.equal(approval.expires_at, deadline);
  assert.equal(f.requests.filter((request) => request.method === 'POST').length, 0);
});

test('dependency-blocked approval conflict reloads availability once without repeating the decision', async (t) => {
  const data = backgroundSnapshot(), approval = data.approvals[0];
  const f = await fixture(t, { data, assistant: true, hash: '#/assistant/background' });
  await f.page.getByRole('button', { name: 'Allow once', exact: true }).waitFor();
  f.control.backgroundHandler = async ({ json }) => { approval.dependency_blocked = true; await json({ error: 'The required tool is unavailable.' }, 409); return true; };
  await f.page.getByRole('button', { name: 'Allow once', exact: true }).click();
  await f.page.getByText('This check is paused or waiting for required tools. Review it in Background before deciding. The original expiry still applies.', { exact: true }).waitFor();
  assert.equal(await f.page.locator('.assistant-approval button').count(), 0);
  const decisions = f.requests.filter((request) => request.method === 'POST' && request.path.includes('/approvals/'));
  assert.equal(decisions.length, 1); assert.deepEqual(decisions[0].body, { approve: true });
  assert.match(await f.page.locator('.assistant-approval').innerText(), /PRIVATE ARGUMENT|Expires /);
});

test('dependency-blocked approval requires an actual boolean before exposing decision controls', async (t) => {
  const data = backgroundSnapshot(); data.approvals[0].dependency_blocked = 0;
  const f = await fixture(t, { data, assistant: true, hash: '#/assistant/background' });
  await f.page.getByText('This request’s availability could not be verified. Reload its current state before deciding.', { exact: true }).waitFor();
  assert.equal(await f.page.locator('.assistant-approval button').count(), 0);
  assert.match(await f.page.locator('.assistant-approval').innerText(), /PRIVATE ARGUMENT|Expires /);
  assert.equal(f.requests.filter((request) => request.method === 'POST').length, 0);
});

test('dependency-blocked approval rejects a still-connected stale button while quick chat delays rendering', async (t) => {
  const data = backgroundSnapshot();
  const f = await fixture(t, { data, assistant: true, hash: '#/assistant/background' });
  await f.page.getByRole('button', { name: 'Allow once', exact: true }).waitFor();
  await f.page.getByRole('button', { name: 'Open quick chat', exact: true }).click();
  await f.page.locator('#assistant-quick').getByRole('heading', { name: 'Private chat', exact: true }).waitFor();
  let start, release;
  const started = new Promise((resolve) => { start = resolve; }), wait = new Promise((resolve) => { release = resolve; });
  f.control.chatHandler = async ({ id, json }) => {
    if (id !== 'private-chat') return false;
    start(); await wait; await json({ conversation: data.conversations[0], messages: [], active_job: null }); return true;
  };
  data.approvals[0].dependency_blocked = true;
  await started; // The current snapshot is blocked; the previous controls are still in the DOM.
  await f.page.getByRole('button', { name: 'Allow once', exact: true }).click();
  await f.page.getByRole('button', { name: 'Deny', exact: true }).click();
  assert.equal(f.requests.filter((request) => request.method === 'POST').length, 0);
  release();
  await f.page.getByText('This check is paused or waiting for required tools. Review it in Background before deciding. The original expiry still applies.', { exact: true }).waitFor();
  assert.equal(await f.page.locator('.assistant-approval button').count(), 0);
});
