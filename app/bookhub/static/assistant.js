/* Assistant view. The same-origin bridge owns authentication; this file only presents state and commands. */
'use strict';

const AssistantUI = (() => {
  let active = null;
  let familyOwner = null;
  let familyContext = null;
  let coreOwner = null;
  let identityEpoch = 0;
  let selectedScope = '';
  let quickWanted = false;
  let launcher = null;
  let focusChatOnMount = false;
  const drafts = new Map();
  const selections = new Map();
  const inFlight = new Map();
  const identityKey = () => identityEpoch + ':' + String(familyOwner) + ':' + String(coreOwner);
  const pathId = (id) => encodeURIComponent(id);
  const list = (value) => Array.isArray(value) ? value : [];
  const dateTime = (at) => at ? new Date(at).toLocaleString() : 'Not scheduled';
  const paragraph = (text, cls = 'dim') => el('p', { class: cls, text });
  const prettyArgs = (args) => { try { return JSON.stringify(JSON.parse(args), null, 2); } catch (_) { return String(args); } };
  const running = (job) => ['queued', 'running', 'retry', 'waiting_approval'].includes(job.status);

  function clearPrivateState() { identityEpoch++; drafts.clear(); selections.clear(); inFlight.clear(); coreOwner = null; selectedScope = ''; }
  function sessionChanged() {
    clearPrivateState(); familyContext = null;
    if (active) active.sessionChanged();
    updateLauncher();
  }
  function identity(profileId, context = S?.assistant_context) {
    if (familyOwner !== profileId || familyContext !== context) {
      if (active) active.stop(); active = null; quickWanted = false;
      clearPrivateState(); familyOwner = profileId; familyContext = context;
    }
    updateLauncher();
    if (quickWanted && !assistantRoute() && !active) openQuick(false).catch(oops);
  }
  const assistantRoute = () => /^#\/?assistant(?:\/|$)/.test(location.hash);
  const fullChatRoute = () => assistantRoute() && !['background', 'memory', 'activity', 'permissions'].includes(location.hash.replace(/^#\/?/, '').split('/')[1]);
  function updateLauncher() {
    if (!launcher) {
      launcher = el('button', { class: 'assistant-quick-launcher', type: 'button', text: 'Quick chat',
        'aria-label': 'Open quick chat', 'aria-controls': 'assistant-quick', onclick: () => openQuick().catch(oops) });
      document.body.append(launcher);
    }
    launcher.hidden = !S?.me || !familyContext || S.me.guest || S.me.via_admin || fullChatRoute() || quickWanted ||
      (assistantRoute() && active && !active.snapshot);
    launcher.setAttribute('aria-expanded', String(quickWanted));
  }
  function leave() {
    if (fullChatRoute()) quickWanted = false;
    // A floating chat stays mounted while navigating unrelated Family Hub pages.
    if (active?.quickOnly && !assistantRoute()) return;
    if (active) active.stop(); active = null;
  }
  function quickFrame(content) {
    const frame = el('section', { id: 'assistant-quick', class: 'assistant-quick', role: 'dialog',
      'aria-label': 'Quick chat', 'aria-modal': 'false', onkeydown: (event) => {
        if (event.key === 'Escape' && !event.isComposing && event.target.tagName !== 'SELECT') { event.preventDefault(); closeQuick(); }
      } },
      el('header', { class: 'assistant-quick-header' }, el('strong', { text: 'Quick chat' }),
        el('div', { class: 'row' }, el('button', { class: 'btn sm', type: 'button', text: 'Expand', 'aria-label': 'Expand to main chat', onclick: () => {
          quickWanted = false; focusChatOnMount = true;
          if (active) active.stop(); active = null; updateLauncher();
          location.hash = '#/assistant';
        } }), el('button', { class: 'btn sm', type: 'button', text: 'Close', 'aria-label': 'Close quick chat', onclick: closeQuick }))), content);
    document.body.append(frame); return frame;
  }
  async function openQuick(focus = true) {
    if (!S?.me || !familyContext || S.me.guest || S.me.via_admin || fullChatRoute()) return;
    if (assistantRoute() && active && !active.snapshot) return;
    quickWanted = true; updateLauncher();
    if (active?.quickFrame) { if (focus) active.composer?.focus({ preventScroll: true }); return; }
    if (active && !active.quickOnly && active.snapshot) {
      active.attachQuick(); await active.refresh(); if (focus) active.composer?.focus({ preventScroll: true }); return;
    }
    if (active) active.stop();
    const view = new View('chat', true); active = view;
    try { await view.start(); if (focus && view.live()) (view.composer || view.body).focus({ preventScroll: true }); }
    catch (error) { view.error(error); }
  }
  function closeQuick() {
    quickWanted = false;
    if (active?.quickOnly) { active.stop(); active = null; }
    else active?.detachQuick();
    updateLauncher(); launcher?.focus({ preventScroll: true });
  }
  function replacePreservingFocus(node, ...children) {
    const focused = node.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused && focused.dataset.focusKey;
    const expanded = new Set(Array.from(node.querySelectorAll('details[open][data-key]'), (d) => d.dataset.key));
    fill(node, ...children);
    for (const detail of node.querySelectorAll('details[data-key]')) if (expanded.has(detail.dataset.key)) detail.open = true;
    if (focusKey) {
      const target = Array.from(node.querySelectorAll('[data-focus-key]')).find((n) => n.dataset.focusKey === focusKey);
      (target || node).focus({ preventScroll: true });
    }
  }

  class View {
    constructor(tab, quickOnly = false) {
      this.tab = ['background', 'memory', 'activity', 'permissions'].includes(tab) ? tab : 'chat';
      this.context = familyContext;
      this.quickOnly = quickOnly; this.quickFrame = null; this.quickBody = null; this.scopeSelectors = [];
      this.alive = true; this.timer = null; this.snapshot = null; this.scope = selectedScope; this.selected = ''; this.chat = null;
      this.selectionVersion = 0; this.stateVersion = 0; this.refreshing = null; this.switching = false; this.pending = new Set(); this.transcriptNodes = new Map();
      this.root = el('div', { class: 'assistant-view' });
      this.notice = el('p', { class: 'assistant-notice small', role: 'status', 'aria-live': 'polite' });
      this.body = el('div', { class: 'assistant-body', tabindex: -1 });
      this.controls = el('div', { class: 'assistant-controls' });
      fill(this.root, this.controls, this.notice, this.body);
      if (quickOnly) this.quickFrame = quickFrame(this.root); else setMain(this.root);
    }
    live() { return this.alive && this.root.isConnected; }
    stop() { this.alive = false; clearTimeout(this.timer); this.quickFrame?.remove(); }
    attachQuick() {
      if (this.quickFrame || !this.snapshot || this.tab === 'chat') return;
      this.quickBody = el('div', { class: 'assistant-body', tabindex: -1 });
      this.quickNotice = el('p', { class: 'assistant-notice small', role: 'status' });
      const content = el('div', { class: 'assistant-view' },
        field('Workspace', this.workspaceSelector('Quick chat workspace')), this.quickNotice, this.quickBody);
      this.quickFrame = quickFrame(content); this.buildChat();
    }
    detachQuick() {
      this.selectionVersion++;
      this.quickFrame?.remove(); this.quickFrame = null; this.quickBody = null; this.quickNotice = null;
      this.scopeSelectors = this.scopeSelectors.filter((select) => select.isConnected);
      this.transcript = null; this.composer = null; this.chat = null; this.selected = '';
      this.transcriptNodes.clear(); this.conversationSignature = '';
    }
    async request(method, path, body, finishAfterUnmount = false) {
      const owner = identityKey();
      const current = () => owner === identityKey() && this.context === familyContext && (finishAfterUnmount || this.live());
      if (!this.context || !current()) throw new Stale('sign-in changed');
      try {
        const result = await api(method, '/api/assistant/' + path, body, current,
          { 'X-Assistant-Context': this.context });
        if (path === 'login' || path === 'logout') this.acceptContext(result.context);
        return result;
      } catch (error) {
        if (!current()) throw new Stale('moved on');
        if (path === 'login' && error.context && error.code !== 'assistant_session_changed') {
          clearPrivateState(); this.acceptContext(error.context);
        } else if (error.status === 401 || error.code === 'assistant_session_changed') {
          sessionChanged();
          throw new Stale('sign-in changed');
        }
        throw error;
      }
    }
    acceptContext(context) {
      if (!/^[a-f0-9]{64}$/.test(context || '')) throw new Error('The assistant returned an invalid session. Reload Family Hub.');
      this.context = context; familyContext = context; S.assistant_context = context;
    }
    sessionChanged() {
      clearTimeout(this.timer);
      if (!this.quickOnly && this.quickFrame) { this.detachQuick(); quickWanted = false; }
      this.alive = false; this.snapshot = null; this.chat = null; this.composer = null; this.transcript = null;
      this.transcriptNodes.clear(); fill(this.controls); fill(this.notice);
      fill(this.body, el('h1', { text: 'Your sign-in changed' }),
        paragraph('Reload Family Hub before continuing. Your previous chat and unsent message have been cleared from this view.'),
        el('button', { class: 'btn pri', type: 'button', text: 'Reload Family Hub', onclick: () => route() }));
    }
    error(error) {
      if (!this.live() || error instanceof Stale) return;
      this.notice.classList.add('bad'); this.notice.textContent = error.message;
      if (this.quickNotice) { this.quickNotice.classList.add('bad'); this.quickNotice.textContent = error.message; }
    }
    announce(message) {
      this.notice.classList.remove('bad'); this.notice.textContent = message;
      if (this.quickNotice) { this.quickNotice.classList.remove('bad'); this.quickNotice.textContent = message; }
    }
    async start() {
      if (S.me.via_admin) {
        fill(this.body, el('h1', { text: 'Sign in as yourself' }), paragraph('The assistant is available only after signing directly into your own Family Hub profile.'));
        return;
      }
      const status = await this.request('GET', 'status');
      if (!status.configured) {
        fill(this.body, el('h1', { text: 'Assistant' }), paragraph('The assistant server has not been connected to this Family Hub yet.'),
          paragraph('Once the connection is configured, your chats and permission requests will appear here.', 'small dim'));
        return;
      }
      if (!status.signed_in) { clearPrivateState(); this.loginForm(); updateLauncher(); return; }
      if (coreOwner !== status.user.id) { clearPrivateState(); coreOwner = status.user.id; }
      try { await this.refresh(); }
      catch (error) {
        this.error(error);
        if (!this.snapshot && this.live()) this.reconnectButton();
      }
      this.schedule();
      updateLauncher();
    }
    reconnectButton() {
      fill(this.body, el('h1', { text: 'Assistant unavailable' }), paragraph('Your other Family Hub features are still available.'),
        el('button', { class: 'btn', type: 'button', text: 'Try again', onclick: () => this.start().catch((error) => this.error(error)) }),
        el('button', { class: 'btn', type: 'button', text: 'Sign in again', onclick: () => { this.loginForm(); } }));
    }
    loginForm() {
      if (!this.quickOnly && this.quickFrame) { this.detachQuick(); quickWanted = false; updateLauncher(); }
      clearTimeout(this.timer); this.snapshot = null; this.chat = null;
      this.scopeSelect = null; this.scopeSelectors = []; this.transcript = null; this.composer = null; this.selected = '';
      this.transcriptNodes.clear(); this.backgroundSignature = ''; this.conversationSignature = '';
      const account = el('input', { type: 'text', autocomplete: 'username', required: true, maxlength: 1024 });
      const password = el('input', { type: 'password', autocomplete: 'current-password', required: true, maxlength: 1024 });
      const submit = el('button', { class: 'btn pri', type: 'submit', text: 'Sign in to Assistant' });
      let submitting = false;
      fill(this.controls);
      fill(this.body, el('h1', { text: 'Your assistant account' }),
        paragraph('Sign in to connect your private workspace and the spaces you share.'),
        el('form', { class: 'panel cut assistant-login', onsubmit: async (event) => {
          event.preventDefault(); if (submitting) return;
          submitting = true; submit.disabled = true;
          const body = { login: account.value.trim(), password: password.value }; password.value = '';
          try {
            const result = await this.request('POST', 'login', body);
            clearPrivateState(); coreOwner = result.user.id; this.announce('Signed in as ' + result.user.name + '.');
            await this.refresh(); this.schedule(); updateLauncher(); this.body.focus({ preventScroll: true });
          } catch (error) { this.error(error); if (this.live()) password.focus(); }
          finally { body.password = ''; submitting = false; submit.disabled = false; }
        } }, field('Assistant account', account), field('Password', password), submit));
    }
    schedule() {
      clearTimeout(this.timer);
      if (!this.live()) return;
      this.timer = setTimeout(async () => {
        if (!this.live()) return;
        if (!document.hidden && !this.pending.size) {
          try { await this.refresh(); }
          catch (error) {
            this.error(error);
            try {
              const status = await this.request('GET', 'status');
              if (!status.signed_in) { clearPrivateState(); this.loginForm(); return; }
            } catch (_) { /* Preserve the useful error without showing connection details. */ }
          }
        }
        this.schedule();
      }, 2500);
    }
    async refresh() {
      if (!this.live()) return;
      if (this.refreshing) { await this.refreshing; return this.refresh(); }
      const version = this.stateVersion;
      this.refreshing = (async () => {
        const snapshot = await this.request('GET', 'state');
        if (version !== this.stateVersion) return;
        this.snapshot = snapshot;
        const previousScope = this.scope;
        if (!list(snapshot.spaces).some((s) => s.id === this.scope)) this.scope = snapshot.user.private_space;
        if (!list(snapshot.spaces).some((s) => s.id === this.scope)) this.scope = list(snapshot.spaces)[0]?.id || '';
        if (this.tab === 'permissions' && previousScope !== this.scope) {
          this.grantsScope = null;
          fill(this.body, paragraph('Loading permissions for this workspace…', 'small dim'));
        }
        selectedScope = this.scope;
        if (!this.scopeSelect) this.buildControls();
        this.scopeSelectors.forEach((select) => { select.value = this.scope; });
        if (this.tab === 'chat' || this.quickBody) {
          if (!this.transcript) this.buildChat();
          this.renderConversations();
          const conversations = this.conversations();
          const remembered = selections.get(this.scope);
          const rememberedExists = conversations.some((c) => c.id === remembered);
          if (!conversations.some((c) => c.id === this.selected) || (rememberedExists && remembered !== this.selected)) {
            this.selected = conversations.find((c) => c.id === remembered)?.id || conversations[0]?.id || '';
            this.selectionVersion++; this.chat = null; this.transcriptNodes.clear(); fill(this.transcript);
            this.composer.value = drafts.get(this.selected || this.scope) || '';
          }
          if (this.selected && (!remembered || rememberedExists)) selections.set(this.scope, this.selected);
          this.updateComposer();
          await this.loadChat();
        }
        if (this.tab === 'permissions') await this.loadGrants();
        else if (this.tab !== 'chat') this.renderBackground();
      })();
      try { await this.refreshing; } finally { this.refreshing = null; }
    }
    conversations() { return list(this.snapshot.conversations).filter((c) => c.space_id === this.scope).sort((a, b) => b.updated_at - a.updated_at); }
    workspaceSelector(label = 'Assistant workspace') {
      const select = el('select', { 'aria-label': label, onchange: async () => {
        const hadFocus = document.activeElement === select;
        this.switching = true; this.stateVersion++;
        this.scope = select.value; selectedScope = this.scope; this.selected = ''; this.chat = null; this.selectionVersion++;
        if (this.tab === 'permissions') {
          this.grantsScope = null;
          fill(this.body, paragraph('Loading permissions for this workspace…', 'small dim'));
        }
        if (this.transcript) { this.transcriptNodes.clear(); fill(this.transcript); this.composer.value = drafts.get(this.scope) || ''; }
        this.backgroundSignature = ''; this.conversationSignature = '';
        this.updateComposer();
        try { await this.refresh(); } catch (error) { this.error(error); }
        finally {
          this.switching = false;
          if (this.live()) {
            this.updateComposer();
            if (hadFocus && (!document.activeElement || document.activeElement === document.body)) select.focus({ preventScroll: true });
          }
        }
      } }, list(this.snapshot.spaces).map((space) => el('option', { value: space.id, text: space.name + ' · ' + (space.kind === 'shared' ? 'Shared' : 'Private') })));
      select.value = this.scope; this.scopeSelectors.push(select); return select;
    }
    buildControls() {
      const select = this.workspaceSelector(); this.scopeSelect = select;
      if (this.quickOnly) {
        fill(this.controls, field('Workspace', select), paragraph('Connected as ' + this.snapshot.user.name, 'small dim'));
        return;
      }
      const controlsLinks = [['background', 'Background'], ['memory', 'Memory'], ['activity', 'Activity'], ['permissions', 'Permissions']].map(([id, title]) =>
        el('a', { href: '#/assistant/' + id, 'aria-current': this.tab === id ? 'page' : null, text: title }));
      fill(this.controls,
        el('div', { class: 'row between' }, el('div', {}, el('h1', { text: 'Assistant' }),
          paragraph('Connected as ' + this.snapshot.user.name, 'small dim')), field('Workspace', select)),
        el('div', { class: 'row between assistant-subnav' },
          el('nav', { class: 'assistant-tabs', 'aria-label': 'Assistant areas' },
            el('a', { href: '#/assistant', 'aria-current': this.tab === 'chat' ? 'page' : null, text: 'Chat' }),
            el('details', { open: this.tab !== 'chat' }, el('summary', { text: 'Assistant controls' }), el('div', { class: 'assistant-more-links' }, controlsLinks))),
          el('button', { class: 'btn sm', type: 'button', text: 'Disconnect account', onclick: async (event) => {
            const button = event.currentTarget; if (button.disabled) return; button.disabled = true;
            try { await this.request('POST', 'logout', {}); quickWanted = false; clearPrivateState(); await page(this.tab); }
            catch (error) { this.error(error); button.disabled = false; }
          } })));
    }
    buildChat() {
      this.transcript = el('div', { class: 'assistant-transcript', tabindex: 0, role: 'log', 'aria-label': 'Conversation', 'aria-live': 'polite', 'aria-relevant': 'additions text' });
      this.composer = el('textarea', { rows: 3, maxlength: 16000, placeholder: 'Message your assistant…', 'aria-label': 'Message your assistant',
        oninput: () => { drafts.set(this.selected || this.scope, this.composer.value); this.updateComposer(); },
        onkeydown: (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); this.send(); } } });
      this.sendButton = el('button', { class: 'btn pri', type: 'submit', text: 'Send' });
      this.stopButton = el('button', { class: 'btn', type: 'button', text: 'Stop', hidden: true, onclick: () => {
        if (this.chat?.active_job) this.act('stop-' + this.chat.active_job, 'jobs/' + pathId(this.chat.active_job) + '/stop', {}, this.stopButton);
      } });
      this.chatStatus = el('span', { class: 'small dim', role: 'status' });
      this.scopeHint = el('span', { class: 'small dim' });
      this.chatTitle = el('h2', { class: 'assistant-chat-title', text: 'New conversation' });
      this.permissionLink = el('a', { href: '#/assistant/background', class: 'assistant-permission-link', hidden: true });
      this.conversationList = el('div', { class: 'assistant-conversation-list' });
      this.newButton = el('button', { class: 'btn', type: 'button', text: 'New conversation', onclick: () => this.newChat() });
      const conversations = el('aside', { class: 'assistant-conversations', 'aria-label': 'Conversations in this workspace' }, el('h2', { text: 'Conversations' }), this.newButton, this.conversationList);
      const quick = this.quickOnly || !!this.quickBody;
      fill(this.quickBody || this.body, el('div', { class: 'assistant-chat-layout' },
        el('section', { class: 'assistant-chat panel cut', 'aria-label': 'Assistant chat' }, this.chatTitle, this.permissionLink, this.transcript,
          el('form', { class: 'assistant-composer', onsubmit: (event) => { event.preventDefault(); this.send(); } }, this.composer,
            el('div', { class: 'row between' }, this.scopeHint, el('div', { class: 'row' }, this.stopButton, this.sendButton)),
            el('div', { class: 'row between' }, paragraph('Enter to send · Shift + Enter for a new line', 'small dim'), this.chatStatus))),
        quick ? el('details', { class: 'assistant-quick-conversations' }, el('summary', { text: 'Conversations' }), conversations) : conversations));
    }
    renderConversations() {
      const rows = this.conversations();
      const signature = JSON.stringify([this.scope, this.selected, rows.map((c) => [c.id, c.title])]);
      if (signature === this.conversationSignature) return;
      this.conversationSignature = signature;
      replacePreservingFocus(this.conversationList, rows.length ? rows.map((conversation) => el('button', {
        type: 'button', class: 'assistant-conversation', text: conversation.title || 'New conversation',
        'aria-current': this.selected === conversation.id ? 'true' : null, 'data-focus-key': 'chat-' + conversation.id,
        onclick: async () => {
          if (this.pending.has('send') || this.pending.has('new')) return;
          if (this.selected === conversation.id) return;
          this.selected = conversation.id; selections.set(this.scope, this.selected); this.chat = null; this.selectionVersion++;
          this.transcriptNodes.clear(); fill(this.transcript); this.composer.value = drafts.get(this.selected) || '';
          this.renderConversations(); this.updateComposer();
          try { await this.loadChat(); this.composer.focus(); } catch (error) { this.error(error); }
        }
      })) : paragraph('Your conversations will appear here.', 'small dim'));
    }
    async loadChat() {
      const id = this.selected, version = this.selectionVersion, stateVersion = this.stateVersion;
      if (!id) { this.renderChat(null); return; }
      const chat = await this.request('GET', 'conversations/' + pathId(id));
      if (this.selected !== id || version !== this.selectionVersion || stateVersion !== this.stateVersion) return;
      this.chat = chat; this.renderChat(chat); this.renderConversations();
    }
    renderChat(chat) {
      const messages = list(chat?.messages);
      this.chatTitle.textContent = chat?.conversation.title || 'New conversation';
      const follow = this.transcript.scrollHeight - this.transcript.clientHeight - this.transcript.scrollTop < 80;
      if (!messages.length) {
        if (!this.transcript.querySelector('.assistant-empty')) {
          this.transcriptNodes.clear();
          fill(this.transcript, el('div', { class: 'assistant-empty' }, el('h3', { text: 'What would you like to do?' }),
            paragraph('Try asking to summarise your inbox, save important attachments, or watch for new mail.'),
            paragraph('The local test agent uses sample inboxes. It will ask when an action needs your permission.', 'small dim')));
        }
      } else {
        this.transcript.querySelector('.assistant-empty')?.remove();
        const keep = new Set(messages.map((m) => m.id));
        for (const [id, node] of this.transcriptNodes) if (!keep.has(id)) { node.remove(); this.transcriptNodes.delete(id); }
        for (const message of messages) {
          let node = this.transcriptNodes.get(message.id);
          if (!node) {
            node = el('article', { class: 'assistant-message ' + (message.role === 'user' ? 'from-user' : 'from-assistant') },
              el('span', { class: 'assistant-message-role', text: message.role === 'user' ? 'You' : 'Assistant' }),
              el('div', { class: 'assistant-message-text' }), el('span', { class: 'assistant-message-state small dim' }));
            this.transcriptNodes.set(message.id, node); this.transcript.append(node);
          }
          const body = node.querySelector('.assistant-message-text');
          if (body.textContent !== message.text) body.textContent = message.text;
          const state = node.querySelector('.assistant-message-state');
          const status = ['failed', 'stopped', 'interrupted', 'outcome_unknown'].includes(message.status) ? message.status.replaceAll('_', ' ') : '';
          if (state.textContent !== status) state.textContent = status;
        }
      }
      if (follow) this.transcript.scrollTop = this.transcript.scrollHeight;
      const approvals = list(this.snapshot.approvals).filter((a) => a.space_id === this.scope && a.status === 'pending');
      this.permissionLink.hidden = !approvals.length;
      this.permissionLink.textContent = approvals.length + ' permission request' + (approvals.length === 1 ? '' : 's') + ' waiting · Review';
      this.updateComposer();
    }
    updateComposer() {
      const busy = this.pending.has('send') || this.pending.has('new') || this.switching || inFlight.has(this.scope);
      this.scopeSelectors.forEach((select) => { select.disabled = busy; });
      if (!this.composer) return;
      const loading = !!this.selected && !this.chat;
      const activeJob = this.chat?.active_job;
      this.composer.disabled = busy || loading;
      for (const button of this.conversationList.querySelectorAll('button')) button.disabled = busy;
      this.sendButton.disabled = busy || loading || !!activeJob || !this.scope || !this.composer.value.trim();
      this.stopButton.hidden = !activeJob;
      this.newButton.disabled = busy;
      const status = list(this.chat?.messages).at(-1)?.status;
      this.chatStatus.textContent = busy ? 'Sending…' : loading ? 'Loading…' : status === 'waiting_approval' ? 'Waiting for permission' : activeJob ? 'Working…' : '';
      const space = list(this.snapshot.spaces).find((s) => s.id === this.scope);
      this.scopeHint.textContent = space ? space.name + (space.kind === 'shared' ? ' · visible to this space’s members' : ' · private to you') : '';
    }
    async newChat() {
      if (this.pending.has('new') || this.pending.has('send') || inFlight.has(this.scope)) return;
      const scope = this.scope, requestKey = Symbol('new-chat'); inFlight.set(scope, requestKey);
      this.pending.add('new'); this.stateVersion++; this.updateComposer();
      try {
        const conversation = await this.request('POST', 'conversations', { space_id: scope }, true);
        selections.set(scope, conversation.id);
        if (!this.live() || !this.composer) return;
        this.snapshot.conversations.push(conversation); this.selected = conversation.id;
        this.chat = null; this.selectionVersion++; this.transcriptNodes.clear(); fill(this.transcript); this.composer.value = '';
        await this.loadChat(); this.renderConversations();
      } catch (error) { this.error(error); }
      finally {
        if (inFlight.get(scope) === requestKey) inFlight.delete(scope);
        this.pending.delete('new'); if (this.live()) { this.updateComposer(); this.composer?.focus({ preventScroll: true }); }
      }
    }
    async send() {
      const text = this.composer.value.trim();
      if (!text || this.pending.has('send') || this.pending.has('new') || inFlight.has(this.scope) || this.switching || this.chat?.active_job || (this.selected && !this.chat)) return;
      const scope = this.scope, requestKey = Symbol('send-chat'); inFlight.set(scope, requestKey);
      this.pending.add('send'); this.stateVersion++; this.updateComposer();
      let id = this.selected;
      try {
        if (!id) {
          const conversation = await this.request('POST', 'conversations', { space_id: scope }, true);
          id = conversation.id; this.selected = id; selections.set(scope, id); this.snapshot.conversations.push(conversation);
          drafts.set(id, text); drafts.delete(scope);
        }
        const started = await this.request('POST', 'conversations/' + pathId(id) + '/messages', { text }, true);
        drafts.delete(id);
        if (!this.live() || !this.composer) return;
        if (id === this.selected) {
          this.composer.value = '';
          if (this.chat) this.chat.active_job = started.job_id;
          await this.loadChat();
        }
        this.announce('Message sent.');
      } catch (error) { this.error(error); }
      finally {
        if (inFlight.get(scope) === requestKey) inFlight.delete(scope);
        this.pending.delete('send'); if (this.live()) { this.updateComposer(); this.composer?.focus({ preventScroll: true }); }
      }
    }
    async act(key, path, body, button) {
      const operation = key.replace(/^(allow|deny)-/, 'approval-').replace(/^(pause|cancel)-/, 'responsibility-');
      if (this.pending.has(operation)) return;
      const hadFocus = document.activeElement === button;
      this.pending.add(operation); this.stateVersion++; button.disabled = true;
      for (const sibling of this.root.querySelectorAll('[data-operation]')) if (sibling.dataset.operation === operation) sibling.disabled = true;
      try {
        await this.request('POST', path, body); this.pending.delete(operation);
        this.announce('Saved.'); this.backgroundSignature = ''; await this.refresh();
      } catch (error) { this.error(error); }
      finally {
        this.pending.delete(operation);
        if (this.live()) {
          button.disabled = false;
          for (const sibling of this.root.querySelectorAll('[data-operation]')) if (sibling.dataset.operation === operation) sibling.disabled = false;
          if (hadFocus && (!document.activeElement || document.activeElement === document.body)) {
            const next = Array.from(this.root.querySelectorAll('[data-focus-key]')).find((node) => node.dataset.focusKey === key);
            (next || this.quickBody || this.body).focus({ preventScroll: true });
          }
        }
      }
    }
    action(label, key, path, body, cls = 'btn') {
      const operation = key.replace(/^(allow|deny)-/, 'approval-').replace(/^(pause|cancel)-/, 'responsibility-');
      const button = el('button', { class: cls, type: 'button', text: label, 'data-focus-key': key,
        'data-operation': operation, disabled: this.pending.has(operation), onclick: () => this.act(key, path, body, button) });
      return button;
    }
    async loadGrants(force = false) {
      if (!force && this.grantsScope === this.scope) return;
      const scope = this.scope;
      const version = this.stateVersion;
      let result;
      try {
        result = await this.request('GET', 'grants?space_id=' + encodeURIComponent(scope));
        if (!Array.isArray(result.grants) || result.grants.some((grant) => grant.space_id !== scope)) throw new Error('Permissions could not be loaded for this workspace.');
      } catch (error) {
        if (this.live() && scope === this.scope) this.grantsLoadError = error.message;
        throw error;
      }
      if (!this.live() || scope !== this.scope || version !== this.stateVersion) return;
      if (this.grantsLoadError && this.notice.textContent === this.grantsLoadError) this.announce('');
      this.grantsLoadError = null;
      this.grantsScope = scope;
      replacePreservingFocus(this.body, el('h2', { text: 'Permissions' }),
        paragraph('Choose what your assistant may do in this workspace. These settings belong to your account, including in a shared workspace.'),
        paragraph('Changes apply after Save. Existing approvals are rechecked when a permission changes. Work already dispatched cannot be undone here.', 'small dim'),
        el('div', { class: 'assistant-records' }, list(result.grants).map((grant) => this.grantCard(grant))));
    }
    grantCard(grant) {
      const behavior = el('select', { 'aria-label': 'Behavior for ' + grant.capability },
        [['allow', 'Automatic within these limits'], ['current_task', 'Only for a verified current request'],
          ['conditional', 'Conditional'], ['ask', 'Ask each time'], ['deny', 'Blocked'], ['manual', 'Manual only']]
          .map(([value, text]) => el('option', { value, text })));
      behavior.value = ({ autonomous: 'allow', confirm: 'ask' })[grant.mode] || grant.mode;
      const help = paragraph('', 'small dim');
      const resourceMode = el('select', { 'aria-label': 'Resource access for ' + grant.capability },
        el('option', { value: 'all', text: 'All eligible resources, including new ones' }),
        el('option', { value: 'selected', text: 'Only selected resources' }));
      resourceMode.value = grant.resources === null ? 'all' : 'selected';
      const resourceChecks = list(grant.resource_choices).map((choice) => {
        const input = el('input', { type: 'checkbox', value: choice.value });
        input.checked = list(grant.resources).includes(choice.value);
        return { input, node: el('label', { class: 'assistant-grant-choice' }, input, el('span', { text: choice.label })) };
      });
      for (const missing of list(grant.resources).filter((value) => !list(grant.resource_choices).some((c) => c.value === value))) {
        const input = el('input', { type: 'checkbox', value: missing }); input.checked = true;
        resourceChecks.push({ input, node: el('label', { class: 'assistant-grant-choice' }, input, el('span', { text: 'Unavailable selection: ' + missing + ' — remove before saving' })) });
      }
      const resourceList = el('div', { class: 'assistant-grant-choices' },
        resourceChecks.length ? resourceChecks.map((item) => item.node) : paragraph('No resources are currently available.', 'small dim'),
        paragraph('An empty selection blocks this action for every resource.', 'small dim'));
      const expiryMode = el('select', { 'aria-label': 'Expiry for ' + grant.capability },
        el('option', { value: 'none', text: 'No expiry' }), el('option', { value: 'until', text: 'Until a date and time' }));
      expiryMode.value = grant.expires_at === null ? 'none' : 'until';
      const expiry = el('input', { type: 'datetime-local', 'aria-label': 'Permission expiry date and time' });
      if (grant.expires_at) {
        const date = new Date(grant.expires_at);
        expiry.value = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      }
      const destinationChecks = list(grant.destination_choices).map((choice) => {
        const allow = el('input', { type: 'checkbox', value: choice.value }); allow.checked = list(grant.destinations).includes(choice.value);
        const automatic = el('input', { type: 'checkbox', value: choice.value }); automatic.checked = list(grant.auto_destinations).includes(choice.value);
        allow.addEventListener('change', () => { automatic.disabled = !allow.checked; if (!allow.checked) automatic.checked = false; });
        automatic.disabled = !allow.checked;
        return { allow, automatic, node: el('div', {},
          el('label', { class: 'assistant-grant-choice' }, allow, el('span', { text: 'Allow the configured connector' })),
          el('label', { class: 'assistant-grant-choice' }, automatic, el('span', { text: 'Use without asking when Conditional is selected' }))) };
      });
      const status = paragraph('', 'small dim'); status.setAttribute('role', 'status');
      const save = el('button', { class: 'btn pri', type: 'submit', text: 'Save permission', 'data-save-grant': '' });
      const reload = el('button', { class: 'btn', type: 'button', text: 'Reload permissions', onclick: async () => {
        try { await this.loadGrants(true); } catch (error) { this.error(error); }
      } });
      const update = () => {
        resourceList.hidden = resourceMode.value !== 'selected'; expiry.hidden = expiryMode.value !== 'until';
        help.textContent = ({ allow: 'Routine actions may run automatically within this saved scope.',
          current_task: 'A matching request must be verified. Otherwise the assistant asks for the exact action.',
          conditional: 'Actions outside automatic connector choices require review. Hard limits still apply.',
          ask: 'Every new action waits for your answer. You can answer later.',
          deny: 'The assistant cannot use this tool.', manual: 'This tool stays unavailable to autonomous execution.' })[behavior.value];
      };
      behavior.addEventListener('change', update); resourceMode.addEventListener('change', update); expiryMode.addEventListener('change', update); update();
      let saving = false;
      const form = el('form', { class: 'assistant-grant-form', onsubmit: async (event) => {
        event.preventDefault();
        if (saving || !this.live() || this.switching || this.scope !== grant.space_id || this.grantsScope !== grant.space_id || !card.isConnected) return;
        const expiresAt = expiryMode.value === 'none' ? null : new Date(expiry.value).getTime();
        if (expiresAt !== null && !Number.isFinite(expiresAt)) { status.textContent = 'Choose an expiry date and time.'; return; }
        const change = { space_id: grant.space_id, capability: grant.capability, expected_revision: grant.revision,
          mode: behavior.value, expires_at: expiresAt,
          resources: resourceMode.value === 'all' ? null : resourceChecks.filter((item) => item.input.checked).map((item) => item.input.value),
          destinations: destinationChecks.filter((item) => item.allow.checked).map((item) => item.allow.value),
          auto_destinations: destinationChecks.filter((item) => item.allow.checked && item.automatic.checked).map((item) => item.automatic.value) };
        saving = true; save.disabled = true; status.textContent = 'Saving…';
        const scope = this.scope;
        try {
          const saved = await this.request('POST', 'grants', change);
          if (this.live() && this.scope === scope && card.isConnected) {
            const replacement = this.grantCard(saved); replacement.open = true; card.replaceWith(replacement);
            replacement.querySelector('[data-save-grant]')?.focus({ preventScroll: true });
            this.announce('Permission saved. Pending actions will use the current limits.');
          }
        } catch (error) {
          if (!(error instanceof Stale)) status.textContent = error.status === 409 ? 'This permission changed elsewhere. Your edits remain here. Reload before saving again.' : error.message;
        } finally { saving = false; save.disabled = false; }
      } }, paragraph(({ read: 'Reads information', local_write: 'Changes local data', external_write: 'Changes an external service',
          destructive: 'Can remove data', financial: 'Can move or spend money', credential_use: 'Uses a protected connection',
          permission_change: 'Changes access permissions' })[grant.effect] || 'Effect awaiting operator review', 'small dim'),
        field('Behavior', behavior), help,
        !grant.reviewed ? paragraph('This connector needs operator review before it can run automatically.', 'small dim') : null,
        grant.resource_scope === 'connector' ? paragraph('This grant covers the connector tool as a whole. It cannot restrict individual URLs, recipients or records inside that tool.', 'small dim') : null,
        field('Resources', resourceMode), resourceList,
        destinationChecks.length ? el('div', {}, el('h4', { text: 'Connector access' }), destinationChecks.map((item) => item.node)) : null,
        field('Expiry', expiryMode), expiry, paragraph('Dates and times use this device’s timezone. An expiry must be within one year.', 'small dim'),
        el('div', { class: 'row' }, save, reload), status);
      const card = el('details', { class: 'panel cut assistant-grant', 'data-key': grant.capability },
        el('summary', {}, el('strong', { text: grant.capability }), el('span', { class: 'small dim', text: ' · ' + behavior.selectedOptions[0].textContent })),
        paragraph(grant.description, 'small dim'), form);
      return card;
    }
    renderBackground() {
      const snapshot = this.snapshot;
      const scoped = (name) => list(snapshot[name]).filter((row) => row.space_id === this.scope);
      const signature = JSON.stringify([this.tab, this.scope, snapshot.approvals, snapshot.responsibilities, snapshot.jobs, snapshot.preferences, snapshot.notices,
        list(snapshot.approvals).map((a) => a.expires_at <= Date.now())]);
      if (signature === this.backgroundSignature) return;
      this.backgroundSignature = signature;
      if (this.tab === 'memory') {
        const privateScope = this.scope === snapshot.user.private_space;
        replacePreservingFocus(this.body, el('h2', { text: 'Memory' }),
          paragraph(privateScope ? 'Preferences the assistant saved with your permission. Remembering a preference does not grant a new permission.' : 'Private memories appear only in your private workspace.'),
          privateScope ? el('div', { class: 'assistant-records' }, list(snapshot.preferences).length ? snapshot.preferences.map((p) =>
            el('article', { class: 'panel cut' }, paragraph(p.text, ''), paragraph('Saved ' + dateTime(p.created_at), 'small dim'))) : paragraph('No saved preferences.')) : null);
        return;
      }
      if (this.tab === 'activity') {
        replacePreservingFocus(this.body, el('h2', { text: 'Activity' }),
          el('div', { class: 'assistant-records' }, scoped('notices').length ? scoped('notices').map((n) =>
            el('article', { class: 'panel cut' }, el('h3', { text: n.title }), paragraph(n.body, ''), paragraph(dateTime(n.created_at), 'small dim'))) : paragraph('No notifications in this workspace.')),
          el('h3', { text: 'Recent work' }), this.jobList(scoped('jobs').slice(0, 30)));
        return;
      }
      const approvals = scoped('approvals').filter((a) => a.status === 'pending');
      const responsibilities = scoped('responsibilities');
      replacePreservingFocus(this.body, el('h2', { text: 'Background' }),
        paragraph('Follow-ups continue while the assistant server is running. Permission requests wait here until you decide or they expire.'),
        el('section', { class: 'assistant-records', 'aria-label': 'Permission requests' },
          el('h3', { text: 'Permission requests' }), approvals.length ? approvals.map((approval) => {
            const expired = approval.expires_at <= Date.now();
            return el('article', { class: 'panel cut assistant-approval' }, el('h3', { text: approval.capability }),
              paragraph('Allow once authorises only the exact action below. It does not change your standing permissions.', 'small dim'),
              el('pre', { class: 'assistant-arguments', tabindex: 0, 'aria-label': 'Exact action arguments', text: prettyArgs(approval.arguments) }),
              paragraph((expired ? 'Expired ' : 'Expires ') + dateTime(approval.expires_at), 'small dim'),
              el('div', { class: 'row' }, expired ? paragraph('This request can no longer be approved.', 'small dim') :
                this.action('Allow once', 'allow-' + approval.id, 'approvals/' + pathId(approval.id), { approve: true }, 'btn pri'),
                this.action('Deny', 'deny-' + approval.id, 'approvals/' + pathId(approval.id), { approve: false })));
          }) : paragraph('No permission requests waiting.', 'small dim')),
        el('section', { class: 'assistant-records', 'aria-label': 'Follow-ups' }, el('h3', { text: 'Follow-ups' }),
          responsibilities.length ? responsibilities.map((r) => el('article', { class: 'panel cut' },
            el('div', { class: 'row between' }, el('h3', { text: r.title }), el('span', { class: 'small dim', text: r.status })), paragraph(r.reason, ''),
            paragraph('Next check: ' + dateTime(r.next_check_at), 'small dim'),
            el('details', { 'data-key': r.id }, el('summary', { text: 'Scope and limits' }),
              paragraph(r.instruction, ''), paragraph('Stop when: ' + r.stop_condition, 'small dim'),
              paragraph(r.remaining_checks + ' checks left · expires ' + dateTime(r.expires_at), 'small dim'),
              paragraph('Event: ' + (r.event_kind || 'None') + (r.event_resource ? ' · ' + r.event_resource : ''), 'small dim')),
            ['active', 'paused'].includes(r.status) ? el('div', { class: 'row' },
              r.status === 'active' || r.owner_id === snapshot.user.id ? this.action(r.status === 'active' ? 'Pause' : 'Resume', 'pause-' + r.id,
                'responsibilities/' + pathId(r.id), { status: r.status === 'active' ? 'paused' : 'active', revision: r.revision }) : null,
              this.action('Cancel follow-up', 'cancel-' + r.id, 'responsibilities/' + pathId(r.id), { status: 'cancelled', revision: r.revision })) : null)) :
            paragraph('Ask the assistant to “Watch my inbox” to try a timed and event-triggered follow-up.', 'small dim')),
        el('section', { class: 'assistant-records' }, el('h3', { text: 'Running now' }), this.jobList(scoped('jobs').filter(running))));
      this.body.tabIndex = -1;
    }
    jobList(jobs) {
      return jobs.length ? el('div', { class: 'assistant-records' }, jobs.map((job) => el('article', { class: 'panel cut' },
        el('div', { class: 'row between' }, el('h3', { text: job.title }), el('span', { class: 'small dim', text: job.status })),
        job.detail ? paragraph(job.detail, 'small dim') : null,
        running(job) && ['chat', 'agent'].includes(job.kind) ? this.action('Stop', 'job-' + job.id, 'jobs/' + pathId(job.id) + '/stop', {}) : null))) : paragraph('Nothing to show in this workspace.', 'small dim');
    }
  }

  async function page(tab) {
    leave();
    identity(S.me?.id);
    const view = new View(tab); active = view;
    updateLauncher();
    try {
      await view.start();
      if (view.live() && quickWanted && view.tab !== 'chat' && view.snapshot) { view.attachQuick(); await view.refresh(); }
      if (view.live() && focusChatOnMount && view.composer && view.tab === 'chat') { focusChatOnMount = false; view.composer.focus({ preventScroll: true }); }
    } catch (error) { view.error(error); }
    updateLauncher();
  }
  return { page, leave, identity, sessionChanged };
})();
