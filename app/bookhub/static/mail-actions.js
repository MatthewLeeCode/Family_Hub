/* Fixed local-draft preset. References are recoverable; source text and authority are never stored. */
'use strict';

const MailActionsUI = (() => {
  const KEY = 'family-hub-mail-requests-v1';
  const reference = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  const uuid = (value) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
  const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const activeStates = ['queued', 'running', 'waiting_approval'];
  const labels = { queued: 'Queued', running: 'Preparing your draft', waiting_approval: 'Waiting for your permission',
    completed: 'Local draft created', cancelled: 'Cancelled', expired: 'Request expired', stale: 'Request is no longer current',
    failed: 'Draft was not created', outcome_unknown: 'Draft outcome is uncertain' };
  const outcomes = { cancelled: 'The request was stopped.', intent_expired: 'Its time limit has passed.',
    session_revoked: 'The original assistant session was disconnected.', source_changed: 'The source message changed.',
    policy_changed: 'The permission changed.', catalog_changed: 'The tool definition changed.', action_denied: 'Current permission does not allow this action.',
    invalid_intent: 'This request is no longer valid.', agent_finished_without_draft: 'The agent finished without creating a draft.',
    execution_failed: 'The request failed.', outcome_unknown: 'An effect may have happened. Do not create another request to retry it.' };
  let binding = null, saved = [];

  function clear() {
    binding = null; saved = [];
    try { sessionStorage.removeItem(KEY); } catch (_) { /* Storage is optional, never authority. */ }
  }
  function bind(context, owner) {
    const next = context + ':' + owner;
    if (binding === next) return;
    binding = next; saved = [];
    try {
      const value = JSON.parse(sessionStorage.getItem(KEY));
      if (value?.context === context && value?.owner === owner && Array.isArray(value.requests)) {
        const pairs = new Set(), ids = new Set();
        saved = value.requests.slice(-20).filter((row) => row && typeof row === 'object' && uuid(row.request_id) && reference(row.message_id) && reference(row.space_id) &&
          digest(row.expected_source_digest) && Number.isFinite(row.created_at) && row.created_at >= 0 && row.created_at <= Date.now() + 60000 &&
          (row.settled !== true || row.created_at > Date.now() - 86400000))
          .reverse().filter((row) => {
            const pair = row.space_id + ':' + row.message_id;
            if (pairs.has(pair) || ids.has(row.request_id)) return false;
            pairs.add(pair); ids.add(row.request_id); return true;
          }).reverse()
          .map((row) => ({ request_id: row.request_id, message_id: row.message_id, space_id: row.space_id,
            expected_source_digest: row.expected_source_digest, created_at: row.created_at, settled: row.settled === true }));
      }
    } catch (_) { /* Treat invalid storage as absent. */ }
    persist(context, owner);
  }
  function persist(context, owner) {
    try { sessionStorage.setItem(KEY, JSON.stringify({ context, owner, requests: saved })); return true; }
    catch (_) { return false; }
  }

  class Action {
    constructor({ root, context, owner, space, message, request, live, openDraft }) {
      Object.assign(this, { root, context, owner, space, message, request, parentLive: live, openDraft });
      this.alive = true; this.busy = false; this.preview = null; this.summary = null; this.timer = null;
      this.uncertain = false; this.retryable = false; this.rejected = false; this.error = ''; this.storageWarning = '';
      bind(context, owner);
      this.record = saved.find((row) => row.message_id === message && row.space_id === space) || null;
      this.source = el('div'); this.controls = el('section', { class: 'inbox-draft-action', tabindex: -1, 'aria-label': 'Draft reply request' });
      fill(root, this.source, this.controls);
    }
    live() { return this.alive && this.parentLive() && this.root.isConnected && binding === this.context + ':' + this.owner; }
    stop() { this.alive = false; clearTimeout(this.timer); this.preview = null; this.summary = null; }
    async call(method, path, body) {
      if (!this.live()) throw new Stale('moved on');
      const value = await this.request(method, '/api/assistant/mail/' + path, body);
      if (!this.live()) throw new Stale('moved on');
      return value;
    }
    remember(record) {
      this.record = record;
      saved = saved.filter((row) => row.message_id !== this.message || row.space_id !== this.space);
      if (record) saved.push(record);
      if (!persist(this.context, this.owner)) this.storageWarning = 'This browser cannot save the request reference. Keep this page open until its result is known.';
    }
    async start() {
      await this.loadPreview();
      if (this.live() && this.record) await this.lookup();
    }
    async loadPreview() {
      if (!this.live() || this.busy) return;
      this.busy = true; this.preview = null; this.error = ''; this.draw();
      fill(this.source, el('p', { class: 'dim', text: 'Loading the current message…' }));
      try {
        const value = await this.call('GET', encodeURIComponent(this.message) + '/draft-intent');
        if (value.kind !== 'mail.local_draft.v1' || value.effect !== 'local_draft_only' || value.message_id !== this.message || value.space_id !== this.space ||
            !digest(value.source_digest) || !value.source || !['sender', 'address', 'subject', 'body'].every((key) => typeof value.source[key] === 'string') ||
            !['allowed', 'approval_required', 'denied', 'manual', 'authentication_required'].includes(value.eligibility) ||
            value.can_request !== ['allowed', 'approval_required'].includes(value.eligibility)) throw new Error('The current message could not be verified.');
        this.preview = value;
        fill(this.source, el('h2', { text: value.source.subject || '(No subject)' }),
          el('p', { class: 'small', text: value.source.sender + ' <' + value.source.address + '>' }),
          el('p', { class: 'small dim', text: 'Mailbox: ' + value.source.mailbox_id + ' · ' + new Date(value.source.received_at).toLocaleString() }),
          el('div', { class: 'inbox-message-body', text: value.source.body }));
      } catch (error) {
        if (error instanceof Stale || !this.live()) return;
        fill(this.source, el('h2', { text: 'Current message unavailable' })); this.error = error.message;
      } finally { this.busy = false; if (this.live()) this.draw(); }
    }
    validateSummary(value) {
      if (value.request_id !== this.record.request_id || value.message_id !== this.message || value.space_id !== this.space ||
          !reference(value.conversation_id) || !reference(value.job_id) || !Object.hasOwn(labels, value.status) ||
          !Number.isSafeInteger(value.expires_at) || value.expires_at < 0 || value.expires_at > 8640000000000000 ||
          (value.outcome_code !== null && value.outcome_code !== 'draft_created' && !Object.hasOwn(outcomes, value.outcome_code)) ||
          activeStates.includes(value.status) !== (value.outcome_code === null) ||
          (value.status === 'outcome_unknown') !== (value.outcome_code === 'outcome_unknown') ||
          (value.status === 'completed') !== (value.outcome_code === 'draft_created') ||
          (value.status === 'completed' && (!reference(value.draft_id) || value.outcome_code !== 'draft_created')) ||
          (value.status !== 'completed' && value.draft_id !== null)) throw new Error('The draft result could not be verified. Check its status again.');
      return value;
    }
    acceptSummary(value) {
      this.summary = this.validateSummary(value);
      this.remember({ ...this.record, settled: !activeStates.includes(this.summary.status) && this.summary.status !== 'outcome_unknown' });
    }
    async submit(retry = false) {
      if (!this.live() || this.busy || (retry ? !this.retryable : (this.record || !this.preview?.can_request || saved.length >= 20))) return;
      if (!retry) this.remember({ request_id: crypto.randomUUID(), message_id: this.message, space_id: this.space,
        expected_source_digest: this.preview.source_digest, created_at: Date.now(), settled: false });
      this.busy = true; this.retryable = false; this.uncertain = true; this.error = ''; this.draw();
      let reconcile = false;
      try {
        const value = await this.call('POST', encodeURIComponent(this.message) + '/draft-runs', {
          request_id: this.record.request_id, expected_source_digest: this.record.expected_source_digest });
        this.acceptSummary(value); this.uncertain = false;
      } catch (error) {
        if (error instanceof Stale || !this.live()) return;
        if (['source_changed', 'action_denied'].includes(error.code) || [400, 403, 404, 422].includes(error.status)) {
          this.rejected = true; this.uncertain = false; this.error = error.message;
        } else { this.error = 'The response was not confirmed. Checking this same request before any retry.'; reconcile = true; }
      } finally { this.busy = false; if (this.live()) this.draw(); }
      if (!this.live()) return;
      if (reconcile) await this.lookup(); else this.schedule();
    }
    async lookup() {
      if (!this.live() || !this.record || this.busy) return;
      clearTimeout(this.timer); this.busy = true; this.retryable = false; this.draw();
      try {
        this.acceptSummary(await this.call('GET', 'draft-runs/' + this.record.request_id));
        this.uncertain = false; this.error = ''; this.rejected = false;
      } catch (error) {
        if (error instanceof Stale || !this.live()) return;
        this.error = error.status === 404 ? 'No admitted request was found. You may retry the same request reference; no new request will be created by a transport retry.' :
          'The request outcome cannot be checked right now. Keep its reference and check again before trying anything else.';
        this.uncertain = true; this.retryable = error.status === 404;
      } finally { this.busy = false; if (this.live()) { this.draw(); this.schedule(); } }
    }
    schedule() {
      clearTimeout(this.timer);
      if (this.live() && this.summary && activeStates.includes(this.summary.status) && !this.uncertain) {
        this.timer = setTimeout(() => { if (document.hidden) this.schedule(); else this.lookup(); }, 2500);
      }
    }
    draw() {
      if (!this.live()) return;
      const focus = this.controls.contains(document.activeElement) ? document.activeElement.dataset.mailFocus : null;
      if (focus) this.restoreFocus = focus;
      else if (document.activeElement && document.activeElement !== document.body && !this.controls.contains(document.activeElement)) this.restoreFocus = null;
      const button = (label, key, callback, disabled = false) => el('button', { type: 'button', class: 'btn', text: label,
        'data-mail-focus': key, disabled: this.busy || disabled, onclick: callback });
      const result = this.summary;
      const eligibility = { allowed: 'Your current permission permits this request.', approval_required: 'You will review the exact action in Chat before it runs.',
        denied: 'Your permissions do not allow drafting this reply.', manual: 'This action is set to human controlled.', authentication_required: 'Your current sign-in cannot authorize this action.' };
      fill(this.controls, el('h3', { text: 'Draft reply' }), el('p', { class: 'small dim', text: 'Local draft only. Nothing is sent to the sender or saved to a mail provider.' }),
        this.preview ? el('p', { class: 'small dim', text: eligibility[this.preview.eligibility] }) : null,
        this.error ? el('p', { class: 'small bad', role: 'status', text: this.error }) : null,
        this.storageWarning ? el('p', { class: 'small bad', text: this.storageWarning }) : null,
        !this.record && saved.length >= 20 ? el('p', { class: 'small bad', text: 'This tab already retains 20 draft requests. Reopen an existing request to check its outcome. A confirmed terminal request can release its reference through “Review message for a new request”; unresolved requests are never discarded to make room.' }) : null,
        result ? el('p', { class: 'inbox-draft-state', role: 'status', text: labels[result.status] + (outcomes[result.outcome_code] ? ' · ' + outcomes[result.outcome_code] : '') }) : null,
        this.record ? el('p', { class: 'small dim inbox-request-ref', text: 'Request reference: ' + this.record.request_id }) : null,
        el('div', { class: 'inbox-draft-buttons' },
          !this.record ? button('Draft reply', 'submit', () => this.submit(), !this.preview?.can_request || saved.length >= 20) : null,
          this.record && !this.rejected ? button('Check request status', 'status', () => this.lookup()) : null,
          this.retryable ? button('Retry same request', 'retry', () => this.submit(true)) : null,
          result ? el('a', { class: 'btn', href: '#/assistant/conversation/' + encodeURIComponent(result.conversation_id), text: result.status === 'waiting_approval' ? 'Review permission in Chat' : 'Open request in Chat' }) : null,
          result?.status === 'completed' ? button('View local draft', 'draft', () => this.openDraft(result)) : null,
          !this.record ? button('Refresh message', 'preview', () => this.loadPreview()) : null,
          this.rejected || (result && !activeStates.includes(result.status) && result.status !== 'outcome_unknown' && !this.uncertain) ?
            button('Review message for a new request', 'new', () => { this.remember(null); this.summary = null; this.rejected = false; this.uncertain = false; this.loadPreview(); }) : null));
      if (this.restoreFocus && !this.busy && (!document.activeElement || document.activeElement === document.body)) {
        const next = Array.from(this.controls.querySelectorAll('[data-mail-focus]')).find((node) => node.dataset.mailFocus === this.restoreFocus && !node.disabled);
        (next || this.controls).focus({ preventScroll: true }); this.restoreFocus = null;
      }
    }
  }
  return { Action, clear };
})();
