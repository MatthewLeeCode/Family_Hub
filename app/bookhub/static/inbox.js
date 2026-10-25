/* Mail is owned by the assistant service. Structured draft requests always use its policy gate. */
'use strict';

const InboxUI = (() => {
  let active = null;
  let profile = null;
  let context = null;
  let epoch = 0;
  const list = (value) => Array.isArray(value) ? value : [];
  const text = (value, cls = 'dim') => el('p', { class: cls, text: value });
  const date = (value) => Number.isFinite(value) ? new Date(value).toLocaleString() : '';
  const size = (value) => value >= 1024 ? (value / 1024).toFixed(1) + ' KB' : value + ' bytes';

  function leave() { active?.stop(); active?.root.remove(); active = null; }
  function identity(nextProfile, nextContext) {
    if (profile !== nextProfile || context !== nextContext) {
      if (profile !== null || context !== null) MailActionsUI.clear();
      leave(); epoch++; profile = nextProfile; context = nextContext;
    }
  }
  function sessionChanged() { epoch++; context = null; MailActionsUI.clear(); active?.sessionChanged(); }
  function options(select, values, selected) {
    const before = Array.from(select.options).map((item) => [item.value, item.textContent]);
    if (JSON.stringify(before) !== JSON.stringify(values)) {
      fill(select, values.map(([value, label]) => el('option', { value, text: label })));
    }
    select.value = selected;
  }

  class View {
    constructor() {
      this.context = context; this.epoch = epoch; this.alive = true;
      this.snapshot = null; this.owner = null; this.scope = ''; this.mailbox = ''; this.chosen = '';
      this.mode = 'emails'; this.query = ''; this.important = false; this.loading = false; this.timer = null;
      this.readerKey = null;
      this.root = el('div', { class: 'inbox-view', tabindex: -1 });
      this.notice = el('p', { class: 'inbox-notice small', role: 'status', 'aria-live': 'polite' });
      this.body = el('div'); fill(this.root, this.notice, this.body); setMain(this.root);
    }
    live() { return this.alive && this.root.isConnected && this.epoch === epoch && this.context === context; }
    stop() { this.alive = false; clearTimeout(this.timer); this.action?.stop(); this.snapshot = null; }
    sessionChanged() {
      this.stop(); this.chosen = ''; this.owner = null; fill(this.notice);
      fill(this.body, el('h1', { text: 'Your sign-in changed' }), text('Previous mail has been cleared from this view.'),
        el('button', { type: 'button', class: 'btn pri', text: 'Reload Family Hub', onclick: () => route() }));
    }
    async request(url, method = 'GET', body) {
      if (!this.context || !this.live()) throw new Stale('sign-in changed');
      try { return await api(method, url, body, () => this.live(), { 'X-Assistant-Context': this.context }); }
      catch (error) {
        if (!this.live()) throw new Stale('moved on');
        if (error.status === 401 || error.code === 'assistant_session_changed') {
          sessionChanged(); AssistantUI.sessionChanged(); NotesUI.sessionChanged(); throw new Stale('sign-in changed');
        }
        throw error;
      }
    }
    async start() {
      if (!this.context || S.me?.guest || S.me?.via_admin) {
        fill(this.body, el('h1', { text: 'Sign in as yourself' }), text('Inbox is available after signing directly into your own Family Hub profile.'));
        return;
      }
      try {
        const status = await this.request('/api/assistant/status');
        if (!status.configured || !status.signed_in) {
          fill(this.body, el('h1', { text: 'Inbox' }), text(status.configured ? 'Connect your assistant account to open your inboxes.' : 'The assistant service has not been connected to this Family Hub yet.'),
            el('a', { class: 'btn', href: '#/assistant', text: 'Open Assistant' }));
          return;
        }
        this.build(); await this.refresh();
      } catch (error) {
        if (error instanceof Stale || !this.live()) return;
        fill(this.body, el('h1', { text: 'Inbox unavailable' }), text('Your other Family Hub features are still available.'),
          el('button', { type: 'button', class: 'btn', text: 'Try again', onclick: () => this.start() }));
        this.notice.textContent = error.message;
      }
    }
    build() {
      this.account = text('', 'small dim');
      this.scopeSelect = el('select', { 'aria-label': 'Inbox workspace', onchange: () => {
        this.scope = this.scopeSelect.value; this.mailbox = ''; this.chosen = ''; this.render();
      } });
      this.mailboxSelect = el('select', { 'aria-label': 'Mailbox', onchange: () => {
        this.mailbox = this.mailboxSelect.value; this.chosen = ''; this.render();
      } });
      this.modeSelect = el('select', { 'aria-label': 'Mail view', onchange: () => {
        this.mode = this.modeSelect.value; this.chosen = ''; this.render();
      } }, el('option', { value: 'emails', text: 'Inbox' }), el('option', { value: 'drafts', text: 'Local drafts' }));
      this.search = el('input', { type: 'search', maxlength: 240, placeholder: 'Search mail', 'aria-label': 'Search mail', oninput: () => {
        this.query = this.search.value; this.renderMessages();
      } });
      this.importantInput = el('input', { type: 'checkbox', onchange: () => {
        this.important = this.importantInput.checked; this.renderMessages();
      } });
      this.importantLabel = el('label', { class: 'inbox-important-filter' }, this.importantInput, 'Important only');
      this.refreshButton = el('button', { class: 'btn', type: 'button', text: 'Refresh', onclick: () => this.refresh() });
      this.count = text('', 'small dim');
      this.messages = el('div', { class: 'inbox-messages', tabindex: -1, 'aria-label': 'Messages' });
      this.reader = el('section', { class: 'inbox-reader panel', tabindex: -1, 'aria-label': 'Message reader' });
      fill(this.body, el('div', { class: 'inbox-heading' }, el('div', {}, el('h1', { text: 'Inbox' }), this.account), this.refreshButton),
        text('This preview contains sample mail. Gmail and Outlook account connections will come later.', 'small dim'),
        el('div', { class: 'inbox-filters' }, field('Workspace', this.scopeSelect), field('Mailbox', this.mailboxSelect), field('View', this.modeSelect)),
        el('div', { class: 'inbox-layout' }, el('aside', { class: 'inbox-index', 'aria-label': 'Browse mail' }, this.search, this.importantLabel, this.count, this.messages), this.reader));
    }
    async refresh() {
      if (!this.live() || this.loading) return;
      clearTimeout(this.timer); this.loading = true; this.refreshButton.disabled = true;
      try {
        const snapshot = await this.request('/api/assistant/state');
        if (!snapshot.user?.id || (this.owner && this.owner !== snapshot.user.id)) {
          sessionChanged(); AssistantUI.sessionChanged(); NotesUI.sessionChanged(); return;
        }
        this.owner = snapshot.user.id; this.snapshot = snapshot;
        this.account.textContent = 'Connected as ' + snapshot.user.name;
        this.render(); this.notice.textContent = ''; this.notice.classList.remove('bad');
      } catch (error) {
        if (error instanceof Stale || !this.live()) return;
        this.notice.textContent = this.snapshot ? 'Mail could not be refreshed. Showing the last successful view.' : 'Mail is unavailable. Use Refresh to try again.';
        this.notice.classList.add('bad');
      } finally {
        this.loading = false;
        if (this.live()) {
          this.refreshButton.disabled = false;
          this.timer = setTimeout(() => { if (document.hidden) this.deferRefresh(); else this.refresh(); }, 10000);
        }
      }
    }
    deferRefresh() {
      if (this.live()) this.timer = setTimeout(() => { if (document.hidden) this.deferRefresh(); else this.refresh(); }, 10000);
    }
    render() {
      if (!this.live() || !this.snapshot) return;
      const spaces = list(this.snapshot.spaces).filter((space) => ['private', 'shared'].includes(space.kind));
      if (!spaces.some((space) => space.id === this.scope)) {
        this.scope = (spaces.find((space) => space.kind === 'private') || spaces[0])?.id || '';
        this.chosen = ''; this.mailbox = '';
      }
      options(this.scopeSelect, spaces.map((space) => [space.id, space.name + (space.kind === 'private' ? ' · Private' : ' · Shared')]), this.scope);
      const mailboxes = list(this.snapshot.mailboxes).filter((box) => box.space_id === this.scope);
      if (!mailboxes.some((box) => box.id === this.mailbox)) this.mailbox = '';
      options(this.mailboxSelect, [['', 'All inboxes'], ...mailboxes.map((box) => [box.id, box.name + ' · ' + box.provider])], this.mailbox);
      // Local draft records do not yet carry a mailbox or importance classification.
      this.mailboxSelect.disabled = this.mode === 'drafts'; this.importantLabel.hidden = this.mode === 'drafts';
      this.renderMessages();
    }
    renderMessages() {
      if (!this.live() || !this.snapshot) return;
      const draft = this.mode === 'drafts';
      const query = this.query.trim().toLocaleLowerCase();
      const mailboxes = list(this.snapshot.mailboxes).filter((box) => box.space_id === this.scope);
      const rows = list(draft ? this.snapshot.drafts : this.snapshot.emails).filter((item) =>
        item.space_id === this.scope && (draft || (mailboxes.some((box) => box.id === item.mailbox_id) &&
          (!this.mailbox || item.mailbox_id === this.mailbox) && (!this.important || item.important))) &&
        (!query || [item.subject, item.sender, item.address, item.recipient, item.body].filter(Boolean).join(' ').toLocaleLowerCase().includes(query)))
        .slice().sort((a, b) => (b.received_at || 0) - (a.received_at || 0));
      if (!rows.some((item) => item.id === this.chosen)) this.chosen = '';
      const focused = this.messages.contains(document.activeElement) ? document.activeElement.dataset.messageId : null;
      const scroll = this.messages.scrollTop;
      fill(this.messages, rows.length ? rows.map((item) => el('button', { type: 'button', class: 'inbox-message',
        'data-message-id': item.id, 'aria-current': this.chosen === item.id ? 'true' : null,
        onclick: () => { this.chosen = item.id; this.renderMessages(); } },
        el('span', { class: 'inbox-sender', text: draft ? 'To: ' + item.recipient : item.sender }),
        el('strong', { text: item.subject || '(No subject)' }),
        el('span', { class: 'small dim', text: draft ? 'Local draft · Not sent' : (item.important ? 'Important · ' : '') + date(item.received_at) }))) : text('No messages match this view.'));
      this.messages.scrollTop = scroll;
      if (focused) (Array.from(this.messages.querySelectorAll('button')).find((button) => button.dataset.messageId === focused) || this.messages).focus({ preventScroll: true });
      this.count.textContent = rows.length + (rows.length === 1 ? ' message' : ' messages');
      const item = rows.find((row) => row.id === this.chosen);
      const assets = list(this.snapshot.assets).filter((asset) => asset.space_id === this.scope && asset.source_message === item?.id);
      const key = JSON.stringify([this.scope, this.mode, item, assets]);
      if (key === this.readerKey) return;
      this.action?.stop(); this.action = null;
      this.readerKey = key;
      if (!item) { fill(this.reader, el('h2', { text: draft ? 'Local drafts' : 'Your inboxes' }), text('Choose a message to read it.')); return; }
      const box = mailboxes.find((mailbox) => mailbox.id === item.mailbox_id);
      const source = el('div');
      fill(source, el('h2', { text: item.subject || '(No subject)' }),
        text(draft ? 'To: ' + item.recipient : item.sender + ' <' + item.address + '>', 'small'),
        text(draft ? 'Stored locally. This draft has not been sent.' : [box?.name, box?.address, date(item.received_at)].filter(Boolean).join(' · '), 'small dim'),
        !draft && item.important ? el('span', { class: 'inbox-tag', text: 'Important' }) : null,
        el('div', { class: 'inbox-message-body', text: item.body }));
      fill(this.reader, source,
        list(item.attachments).length ? el('section', { class: 'inbox-attachments', 'aria-label': 'Attachments' }, el('h3', { text: 'Attachments' }),
          el('ul', {}, item.attachments.map((attachment) => el('li', {}, el('strong', { text: attachment.name }),
            el('span', { class: 'small dim', text: size(attachment.size) + ' · ' + (assets.some((asset) => asset.source_attachment === attachment.id) ? 'Saved to workspace' : 'Not saved') })))),
          text('Saving follows your assistant permissions. File downloads will be available here in a later update.', 'small dim')) : null);
      if (!draft) {
        const scope = this.scope, message = item.id;
        const current = () => this.live() && this.scope === scope && this.mode === 'emails' && this.chosen === message && this.readerKey === key;
        this.action = new MailActionsUI.Action({ root: source, context: this.context, owner: this.owner, space: scope, message,
          live: current, request: (method, path, body) => this.request(path, method, body),
          openDraft: async (result) => {
            try {
              const snapshot = await this.request('/api/assistant/state');
              if (!current()) return;
              if (snapshot.user?.id !== this.owner) { sessionChanged(); AssistantUI.sessionChanged(); NotesUI.sessionChanged(); return; }
              const exact = list(snapshot.drafts).find((row) => row.id === result.draft_id && row.space_id === scope);
              if (!exact) { this.notice.textContent = 'The exact draft is not available in this account. Check the request in Chat.'; return; }
              this.snapshot = snapshot; this.mode = 'drafts'; this.modeSelect.value = 'drafts'; this.mailbox = ''; this.query = ''; this.search.value = '';
              this.chosen = exact.id; this.render(); this.reader.focus({ preventScroll: true });
            } catch (error) { if (!(error instanceof Stale) && current()) this.notice.textContent = error.message; }
          } });
        this.action.start();
      }
    }
  }
  async function page() { leave(); active = new View(); await active.start(); }
  return { page, leave, identity, sessionChanged };
})();
