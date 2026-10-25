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
  const connectionOperations = new Map();
  const controlTabs = ['background', 'memory', 'activity', 'permissions', 'connections'];
  const connectionLabels = { ready: 'Ready', offline: 'Offline', review_required: 'Review required', disabled: 'Disabled', checking: 'Checking' };
  const connectionReasons = {
    ready: 'The reviewed connection is available.', checking: 'Checking the reviewed connection.',
    disabled_by_user: 'Disabled for your account in this workspace.',
    disabled_by_operator: 'Disabled on the assistant server. An operator must enable it.',
    not_reviewed: 'This connection needs operator review before it can be used.',
    artifact_review_required: 'The connection software or configuration changed. Operator review is required.',
    tool_review_required: 'The available tools changed. Operator review is required.',
    artifact_unavailable: 'The reviewed connection software is unavailable.',
    discovery_failed: 'The connection did not answer its health check.', probe_timeout: 'The health check timed out.',
    not_configured: 'This connection is not configured on the assistant server.'
  };
  const followupLabels = { active: 'Scheduled', paused: 'Paused', completed: 'Completed', cancelled: 'Cancelled', expired: 'Expired', exhausted: 'Checks exhausted' };
  const dependencyLabels = { ready: 'Ready', waiting: 'Waiting', blocked: 'Blocked', not_evaluated: 'Not evaluated' };
  const dependencyReasons = {
    legacy_unbound: 'Dependencies not recorded', connector_offline: 'A required connection is offline.',
    connector_checking: 'A required connection is being checked.', connection_disabled: 'A required connection was disabled.',
    connection_removed: 'A required connection is no longer configured.', connection_changed: 'A required connection’s authority changed.', operator_review_required: 'A connection needs operator review on the assistant server.',
    catalog_changed: 'A required tool changed and needs current review.', grant_changed: 'A saved permission changed.',
    grant_unavailable: 'A required permission is unavailable.', grant_denied: 'A required tool is blocked by your permissions.',
    grant_manual: 'A required tool is set to manual use only.', grant_expired: 'A required permission expired.',
    membership_changed: 'Workspace membership changed.', owner_paused: 'This follow-up was paused.',
    unresolved_effect: 'An earlier action has an unresolved outcome. Resuming cannot clear it.',
    responsibility_expired: 'This follow-up expired.', budget_exhausted: 'No checks remain for a new run.'
  };
  const dependencyModes = { autonomous: 'Automatic within saved limits', current_task: 'Verified current request', conditional: 'Conditional', confirm: 'Ask each time', manual: 'Manual only', unavailable: 'Unavailable' };
  const dependencyChanges = { grant_changed: 'Permission changed', catalog_changed: 'Reviewed tool changed', membership_changed: 'Membership changed', connection_changed: 'Connection authority changed' };
  const followupJobStates = ['queued', 'running', 'waiting_approval', 'waiting_dependency', 'outcome_unknown', 'cancelled', 'failed', 'succeeded'];
  const publicId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  const safeCount = (value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
  const safeText = (value, maximum) => typeof value === 'string' && new TextEncoder().encode(value).length <= maximum;
  const fixedReason = (value) => value === null || (typeof value === 'string' && Object.hasOwn(dependencyReasons, value));
  const validAvailability = (state, reason) => typeof state === 'string' && Object.hasOwn(dependencyLabels, state) && fixedReason(reason) &&
    (state === 'ready' ? reason === null : state === 'waiting' ? ['connector_offline', 'connector_checking'].includes(reason) : state !== 'blocked' || reason !== null);
  const validFollowupJob = (job) => job === null || (job && publicId(job.id) && followupJobStates.includes(job.status) && fixedReason(job.block_reason));
  function validDependencies(rows, bound, review = false) {
    if (!Array.isArray(rows) || (bound ? rows.length < 1 || rows.length > 8 : rows.length !== 0)) return false;
    return rows.every((row, index) => row && typeof row.capability === 'string' && /^[a-z][a-z0-9_.-]{0,127}$/.test(row.capability) &&
      (index === 0 || rows[index - 1].capability < row.capability) && (row.connection_id === null || publicId(row.connection_id)) &&
      validAvailability(row.availability, row.reason_code) && (!review || (Object.hasOwn(dependencyModes, row.permission_mode) &&
        Array.isArray(row.changes) && row.changes.length <= 4 && new Set(row.changes).size === row.changes.length && row.changes.every((change) => Object.hasOwn(dependencyChanges, change)))));
  }
  function validFollowup(row, viewer, spaces) {
    return row && ['id', 'space_id', 'owner_id'].every((key) => publicId(row[key])) && spaces.some((space) => space.id === row.space_id) &&
      Object.hasOwn(followupLabels, row.status) && ['bound', 'legacy_unbound'].includes(row.dependency_state) && validAvailability(row.availability, row.block_reason) &&
      validDependencies(row.dependencies, row.dependency_state === 'bound') && validFollowupJob(row.current_job) &&
      [['title', 120], ['instruction', 4000], ['reason', 2000], ['stop_condition', 2000]].every(([key, size]) => safeText(row[key], size)) &&
      ['', 'mail.arrived'].includes(row.event_kind) && (row.event_resource === '' || publicId(row.event_resource)) &&
      safeCount(row.revision, 1) && safeCount(row.remaining_checks, 0, 20) && safeCount(row.expires_at) &&
      [row.next_check_at, row.next_probe_at].every((at) => at === null || safeCount(at)) &&
      ['can_pause', 'can_cancel', 'can_review_resume'].every((key) => typeof row[key] === 'boolean') &&
      (!row.can_pause || row.status === 'active') && (!row.can_cancel || ['active', 'paused'].includes(row.status)) &&
      (!row.can_review_resume || (row.status === 'paused' && row.owner_id === viewer));
  }
  function validResumeReview(value, row, viewer) {
    return value && value.id === row.id && value.space_id === row.space_id && value.owner_id === viewer && value.revision === row.revision &&
      safeCount(value.remaining_checks, 0, 20) && value.remaining_checks === row.remaining_checks && safeCount(value.expires_at) && value.expires_at === row.expires_at &&
      typeof value.can_resume === 'boolean' && fixedReason(value.block_reason) && validFollowupJob(value.current_job) &&
      validDependencies(value.dependencies, true, true) && value.dependencies.length === row.dependencies.length &&
      value.dependencies.every((dependency, index) => dependency.capability === row.dependencies[index].capability && dependency.connection_id === row.dependencies[index].connection_id) &&
      (value.can_resume ? typeof value.review_digest === 'string' && /^[a-f0-9]{64}$/.test(value.review_digest) && value.block_reason === null && value.dependencies.every((dependency) => dependency.availability === 'ready') :
        value.review_digest === null && value.block_reason !== null);
  }
  const followupSignature = (row) => JSON.stringify([row.revision, row.status, row.dependency_state, row.availability, row.block_reason,
    row.dependencies, row.expires_at, row.remaining_checks, row.current_job, row.can_review_resume]);
  const identityKey = () => identityEpoch + ':' + String(familyOwner) + ':' + String(coreOwner);
  const pathId = (id) => encodeURIComponent(id);
  const list = (value) => Array.isArray(value) ? value : [];
  const dateTime = (at) => at ? new Date(at).toLocaleString() : 'Not scheduled';
  const paragraph = (text, cls = 'dim') => el('p', { class: cls, text });
  const prettyArgs = (args) => { try { return JSON.stringify(JSON.parse(args), null, 2); } catch (_) { return String(args); } };
  const running = (job) => ['queued', 'running', 'retry', 'waiting_approval', 'waiting_dependency'].includes(job.status);

  function clearPrivateState() { identityEpoch++; drafts.clear(); selections.clear(); inFlight.clear(); connectionOperations.clear(); coreOwner = null; selectedScope = ''; }
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
  const fullChatRoute = () => assistantRoute() && !controlTabs.includes(location.hash.replace(/^#\/?/, '').split('/')[1]);
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
      this.tab = controlTabs.includes(tab) ? tab : 'chat';
      this.context = familyContext;
      this.quickOnly = quickOnly; this.quickFrame = null; this.quickBody = null; this.scopeSelectors = [];
      this.alive = true; this.timer = null; this.snapshot = null; this.scope = selectedScope; this.selected = ''; this.chat = null;
      this.selectionVersion = 0; this.stateVersion = 0; this.scopeVersion = 0; this.refreshing = null; this.switching = false; this.pending = new Set(); this.transcriptNodes = new Map();
      this.connectionRows = []; this.connectionsScope = null; this.connectionsSignature = ''; this.connectionsNeedsReload = false;
      this.followupReviews = new Map(); this.followupNeedsReload = new Set(); this.approvalNeedsReload = new Set(); this.backgroundVerified = false;
      this.root = el('div', { class: 'assistant-view' });
      this.notice = el('p', { class: 'assistant-notice small', role: 'status', 'aria-live': 'polite' });
      this.body = el('div', { class: 'assistant-body', tabindex: -1 });
      this.controls = el('div', { class: 'assistant-controls' });
      fill(this.root, this.controls, this.notice, this.body);
      if (quickOnly) this.quickFrame = quickFrame(this.root); else setMain(this.root);
    }
    live() { return this.alive && this.root.isConnected; }
    stop() { this.alive = false; clearTimeout(this.timer); this.followupReviews.clear(); this.quickFrame?.remove(); }
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
          if (typeof InboxUI !== 'undefined') InboxUI.sessionChanged();
          if (typeof NotesUI !== 'undefined') NotesUI.sessionChanged();
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
      this.followupReviews.clear(); this.followupNeedsReload.clear();
      this.approvalNeedsReload.clear();
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
      this.followupReviews.clear(); this.followupNeedsReload.clear();
      this.approvalNeedsReload.clear();
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
        if (this.tab === 'background' && (!Array.isArray(snapshot.responsibilities) || snapshot.responsibilities.length > 100 ||
            new Set(snapshot.responsibilities.map((row) => row?.id)).size !== snapshot.responsibilities.length ||
            !snapshot.responsibilities.every((row) => validFollowup(row, snapshot.user?.id, list(snapshot.spaces))))) {
          throw new Error('The follow-up state could not be verified. Reload before using its controls.');
        }
        this.snapshot = snapshot;
        this.followupNeedsReload.clear();
        this.approvalNeedsReload.clear();
        const previousScope = this.scope;
        if (this.initialConversation) {
          const requested = list(snapshot.conversations).find((conversation) => conversation.id === this.initialConversation &&
            list(snapshot.spaces).some((space) => space.id === conversation.space_id));
          if (!requested) {
            this.chat = null; this.composer = null; this.transcript = null;
            this.scopeSelect = null; this.scopeSelectors = []; this.conversationSignature = '';
            fill(this.controls);
            fill(this.body, el('h1', { text: 'Conversation unavailable' }),
              paragraph('This conversation is not available to the current assistant account.'),
              el('a', { class: 'btn', href: '#/assistant', text: 'Open your conversations' }));
            return;
          }
          this.scope = requested.space_id; this.selected = requested.id;
          selections.set(this.scope, this.selected);
        }
        if (!list(snapshot.spaces).some((s) => s.id === this.scope)) this.scope = snapshot.user.private_space;
        if (!list(snapshot.spaces).some((s) => s.id === this.scope)) this.scope = list(snapshot.spaces)[0]?.id || '';
        if (previousScope !== this.scope) this.clearScopedControls();
        if (this.tab === 'background') this.backgroundVerified = true;
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
        if (!this.live() || version !== this.stateVersion) return;
        if (this.tab === 'permissions') await this.loadGrants();
        else if (this.tab === 'connections') await this.loadConnections();
        else if (this.tab !== 'chat') this.renderBackground();
      })();
      try { await this.refreshing; }
      catch (error) {
        if (this.live() && version === this.stateVersion && this.tab === 'background') {
          this.followupReviews.clear(); this.backgroundSignature = ''; this.backgroundVerified = false;
          fill(this.body, el('h2', { text: 'Background unavailable' }), paragraph('The current state could not be verified. Reload before using follow-up controls.'),
            el('button', { class: 'btn', type: 'button', text: 'Reload background', onclick: () => this.refresh().catch((failure) => this.error(failure)) }));
        }
        throw error;
      } finally { this.refreshing = null; }
    }
    conversations() { return list(this.snapshot.conversations).filter((c) => c.space_id === this.scope).sort((a, b) => b.updated_at - a.updated_at); }
    workspaceSelector(label = 'Assistant workspace') {
      const select = el('select', { 'aria-label': label, onchange: async () => {
        const hadFocus = document.activeElement === select;
        this.initialConversation = null;
        this.switching = true; this.stateVersion++;
        this.scope = select.value; selectedScope = this.scope; this.selected = ''; this.chat = null; this.selectionVersion++;
        this.clearScopedControls();
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
      const controlsLinks = [['background', 'Background'], ['memory', 'Memory'], ['activity', 'Activity'], ['permissions', 'Permissions'], ['connections', 'Connections']].map(([id, title]) =>
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
          this.initialConversation = null;
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
      if (chat?.conversation?.id !== id || chat.conversation.space_id !== this.scope) {
        this.chat = null; this.renderChat(null);
        throw new Error('The requested conversation could not be verified. Reload your conversations.');
      }
      if (this.initialConversation === id) this.initialConversation = null;
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
      const jobStatus = list(this.snapshot.jobs).find((job) => job.id === activeJob)?.status;
      this.chatStatus.textContent = busy ? 'Sending…' : loading ? 'Loading…' : status === 'waiting_approval' || jobStatus === 'waiting_approval' ? 'Waiting for permission' :
        jobStatus === 'waiting_dependency' ? 'Waiting for dependencies' : activeJob ? 'Working…' : '';
      const space = list(this.snapshot.spaces).find((s) => s.id === this.scope);
      this.scopeHint.textContent = space ? space.name + (space.kind === 'shared' ? ' · visible to this space’s members' : ' · private to you') : '';
    }
    async newChat() {
      if (this.pending.has('new') || this.pending.has('send') || inFlight.has(this.scope)) return;
      this.initialConversation = null;
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
    async act(key, path, body, button, scope = this.scope, scopeVersion = this.scopeVersion) {
      const operation = key.replace(/^(allow|deny)-/, 'approval-').replace(/^(pause|cancel)-/, 'responsibility-');
      const owner = identityKey(), context = this.context;
      const current = () => this.live() && identityKey() === owner && context === familyContext &&
        this.scope === scope && this.scopeVersion === scopeVersion;
      if (!current() || this.switching || !button.isConnected || this.pending.has(operation)) return;
      const hadFocus = document.activeElement === button;
      this.pending.add(operation); this.stateVersion++; button.disabled = true;
      for (const sibling of this.root.querySelectorAll('[data-operation]')) if (sibling.dataset.operation === operation) sibling.disabled = true;
      try {
        await this.request('POST', path, body); this.pending.delete(operation);
        if (!current()) return;
        this.announce('Saved.'); this.backgroundSignature = ''; await this.refresh();
      } catch (error) {
        if (current() && path.startsWith('approvals/') && error.status === 409) {
          this.approvalNeedsReload.add(decodeURIComponent(path.slice('approvals/'.length)));
          this.backgroundSignature = ''; this.renderBackground();
          try { await this.refresh(); } catch (refreshError) { if (current()) this.error(refreshError); }
        }
        if (current()) this.error(error);
      }
      finally {
        this.pending.delete(operation);
        if (current()) {
          button.disabled = false;
          for (const sibling of this.root.querySelectorAll('[data-operation]')) if (sibling.dataset.operation === operation) sibling.disabled = false;
          if (hadFocus && (!document.activeElement || document.activeElement === document.body)) {
            const next = Array.from(this.root.querySelectorAll('[data-focus-key]')).find((node) => node.dataset.focusKey === key);
            (next || this.quickBody || this.body).focus({ preventScroll: true });
          }
        }
      }
    }
    action(label, key, path, body, cls = 'btn', validate = () => true) {
      const operation = key.replace(/^(allow|deny)-/, 'approval-').replace(/^(pause|cancel)-/, 'responsibility-');
      const scope = this.scope, scopeVersion = this.scopeVersion;
      const button = el('button', { class: cls, type: 'button', text: label, 'data-focus-key': key,
        'data-operation': operation, disabled: this.pending.has(operation), onclick: () => { if (validate()) this.act(key, path, body, button, scope, scopeVersion); } });
      return button;
    }
    clearScopedControls() {
      this.scopeVersion++;
      this.followupReviews.clear(); this.followupNeedsReload.clear();
      this.approvalNeedsReload.clear();
      this.backgroundVerified = false;
      if (['background', 'memory', 'activity'].includes(this.tab)) {
        this.backgroundSignature = '';
        this.announce('');
        const label = this.tab === 'background' ? 'background work' : this.tab;
        fill(this.body, paragraph('Loading ' + label + ' for this workspace…', 'small dim'));
      } else if (this.tab === 'permissions') {
        this.grantsScope = null;
        fill(this.body, paragraph('Loading permissions for this workspace…', 'small dim'));
      } else if (this.tab === 'connections') {
        this.connectionsScope = null; this.connectionsSignature = ''; this.connectionRows = []; this.connectionsNeedsReload = false;
        this.announce('');
        fill(this.body, paragraph('Loading connections for this workspace…', 'small dim'));
      }
    }
    validConnection(row, scope, id = null) {
      return row && /^[A-Za-z0-9_-]{1,128}$/.test(row.id || '') && row.space_id === scope && (!id || row.id === id) &&
        Object.hasOwn(connectionLabels, row.status) && Number.isSafeInteger(row.revision) && row.revision >= 1 &&
        ['enabled', 'operator_disabled', 'user_disabled', 'can_retry', 'can_enable', 'can_disable'].every((key) => typeof row[key] === 'boolean') &&
        row.enabled === (!row.operator_disabled && !row.user_disabled) && (row.status === 'disabled') !== row.enabled &&
        !(row.operator_disabled && row.can_enable) && Number.isSafeInteger(row.tool_count) && row.tool_count >= 0 &&
        (row.last_checked_at === null || (Number.isSafeInteger(row.last_checked_at) && row.last_checked_at >= 0 && row.last_checked_at <= 8640000000000000));
    }
    connectionsUnavailable(message, requireReload = false) {
      const hadFocus = this.body.contains(document.activeElement);
      this.connectionsScope = null; this.connectionsSignature = ''; this.connectionRows = []; this.connectionsNeedsReload = requireReload;
      fill(this.body, el('h2', { text: 'Connections' }), paragraph(message, 'bad'),
        el('button', { class: 'btn', type: 'button', text: 'Reload connection status', 'data-focus-key': 'reload-connections', onclick: async (event) => {
          const button = event.currentTarget;
          if (!this.live() || !button.isConnected || button.disabled || this.switching) return;
          const hadFocus = document.activeElement === button, scope = this.scope;
          button.disabled = true; this.connectionsNeedsReload = false;
          try { await this.refresh(); } catch (error) { this.error(error); }
          finally {
            button.disabled = false;
            if (hadFocus && this.live() && scope === this.scope && !button.isConnected && (!document.activeElement || document.activeElement === document.body)) this.body.focus({ preventScroll: true });
          }
        } }));
      if (hadFocus) this.body.querySelector('button')?.focus({ preventScroll: true });
    }
    async loadConnections() {
      if (this.connectionsNeedsReload) return;
      const scope = this.scope, version = this.stateVersion;
      const current = () => this.live() && scope === this.scope && version === this.stateVersion;
      try {
        const result = await this.request('GET', 'connections?space_id=' + encodeURIComponent(scope));
        if (!current()) return;
        if (!Array.isArray(result.connections) || result.connections.some((row) => !this.validConnection(row, scope)) ||
            new Set(result.connections.map((row) => row.id)).size !== result.connections.length) throw new Error('Connection status could not be loaded for this workspace.');
        this.connectionRows = result.connections; this.connectionsScope = scope; this.renderConnections();
      } catch (error) {
        if (current() && !(error instanceof Stale)) this.connectionsUnavailable(error.message);
      }
    }
    renderConnections() {
      if (this.connectionsScope !== this.scope) return;
      const signature = JSON.stringify([this.scope, this.connectionRows, this.connectionRows.map((row) => connectionOperations.get(row.space_id + ':' + row.id)?.action || '')]);
      if (signature === this.connectionsSignature) return;
      this.connectionsSignature = signature;
      replacePreservingFocus(this.body, el('h2', { text: 'Connections' }),
        paragraph('Connections available to your account in this workspace. Being connected does not grant permission to use a tool.'),
        el('div', { class: 'assistant-records' }, this.connectionRows.length ? this.connectionRows.map((row) => this.connectionCard(row)) :
          paragraph('No connections are configured for your account in this workspace.')),
        paragraph('Retry checks the reviewed connection without calling its tools. Software and tool changes need operator review on the assistant server.', 'small dim'));
    }
    connectionCard(row) {
      const busy = connectionOperations.get(row.space_id + ':' + row.id);
      const status = el('p', { class: 'small dim', role: 'status', text: busy ? (busy.action === 'retry' ? 'Checking connection…' : 'Updating connection…') : '' });
      const confirmation = el('div', { class: 'assistant-connection-confirm', hidden: true });
      const action = (label, name, handler) => el('button', { class: 'btn sm', type: 'button', text: label,
        'aria-label': label + ' ' + row.id, 'data-focus-key': 'connection-' + row.id + '-' + name, disabled: !!busy,
        onclick: (event) => handler(event.currentTarget) });
      const controls = el('div', { class: 'row assistant-connection-actions' });
      const card = el('article', { class: 'panel cut assistant-connection', 'data-connection-id': row.id, tabindex: -1 },
        el('div', { class: 'row between' }, el('h3', { text: row.id }), el('span', { class: 'assistant-connection-status', text: connectionLabels[row.status] })),
        paragraph(Object.hasOwn(connectionReasons, row.reason_code) ? connectionReasons[row.reason_code] : 'The connection status is unavailable.', 'small dim'),
        paragraph(row.tool_count + ' configured ' + (row.tool_count === 1 ? 'tool' : 'tools') + ' · ' +
          (row.last_checked_at === null ? 'Not checked yet' : 'Last checked ' + dateTime(row.last_checked_at)), 'small dim'),
        controls, confirmation, status);
      if (row.can_retry) controls.append(action('Retry', 'retry', () => this.controlConnection(row, 'retry', card, status)));
      if (row.can_enable && !row.operator_disabled) controls.append(action('Enable connection', 'enable', () => this.controlConnection(row, 'enable', card, status)));
      if (row.can_disable) {
        const disable = action('Disable connection', 'disable', () => {
          if (!card.isConnected || this.switching || this.scope !== row.space_id || connectionOperations.has(row.space_id + ':' + row.id)) return;
          confirmation.hidden = false; confirmation.querySelector('button').focus({ preventScroll: true });
        });
        controls.append(disable);
        fill(confirmation, paragraph('Disabling revokes this connection’s standing permissions and pending approvals. Enabling it later does not restore those permissions. Already-dispatched work cannot be undone.', 'small'),
          el('div', { class: 'row' }, action('Disable and revoke access', 'confirm-disable', () => this.controlConnection(row, 'disable', card, status)),
            action('Cancel', 'cancel-disable', () => { confirmation.hidden = true; disable.focus({ preventScroll: true }); })));
      }
      if (row.can_enable) card.append(paragraph('Enabling does not restore revoked permissions or accept software or tool changes.', 'small dim'));
      return card;
    }
    async controlConnection(row, action, card, status) {
      const operation = row.space_id + ':' + row.id;
      if (!this.live() || this.switching || !card.isConnected || this.scope !== row.space_id || this.connectionsScope !== row.space_id ||
          !row['can_' + action] || (action === 'enable' && row.operator_disabled) || connectionOperations.has(operation)) return;
      const token = Symbol(operation), scope = this.scope, version = ++this.stateVersion;
      const hadFocus = card.contains(document.activeElement), focusKey = document.activeElement?.dataset.focusKey;
      const current = () => this.live() && this.scope === scope && version === this.stateVersion;
      connectionOperations.set(operation, { token, action }); this.pending.add('connection-' + row.id);
      this.connectionsSignature = '';
      card.querySelectorAll('button').forEach((button) => { button.disabled = true; });
      status.textContent = action === 'retry' ? 'Checking connection…' : 'Updating connection…';
      try {
        const result = await this.request('POST', 'connections/' + pathId(row.id) + '/control', { space_id: scope, expected_revision: row.revision, action });
        if (!current()) return;
        if (!this.validConnection(result, scope, row.id)) throw new Error('The connection returned an invalid status. Reload before trying again.');
        this.connectionRows = this.connectionRows.map((item) => item.id === row.id ? result : item);
        this.announce(action === 'disable' ? 'Connection disabled. Its permissions and pending approvals were revoked. Already-dispatched work cannot be undone.' :
          action === 'enable' ? 'Connection enabled. Revoked permissions were not restored; check its status before use.' : 'Connection checked. No tools were called.');
      } catch (error) {
        if (current() && !(error instanceof Stale)) this.connectionsUnavailable(error.status === 409 ?
          'This connection changed elsewhere. Reload its status before trying again.' :
          'The connection action could not be confirmed. Reload its status before trying again.', true);
      } finally {
        if (connectionOperations.get(operation)?.token === token) connectionOperations.delete(operation);
        this.pending.delete('connection-' + row.id);
        if (current()) {
          const restoreFocus = hadFocus && (!document.activeElement || document.activeElement === document.body || card.contains(document.activeElement));
          if (this.connectionsScope === scope) {
            this.connectionsSignature = ''; this.renderConnections();
            if (restoreFocus) {
              const target = Array.from(this.body.querySelectorAll('[data-focus-key]')).find((node) => node.dataset.focusKey === focusKey) ||
                Array.from(this.body.querySelectorAll('[data-connection-id]')).find((node) => node.dataset.connectionId === row.id);
              (target || this.body).focus({ preventScroll: true });
            }
          } else if (restoreFocus) this.body.querySelector('button')?.focus({ preventScroll: true });
        }
      }
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
    currentFollowup(row, epoch) {
      const current = list(this.snapshot?.responsibilities).find((item) => item.id === row.id && item.space_id === row.space_id);
      return this.live() && this.backgroundVerified && !this.switching && this.scopeVersion === epoch && this.scope === row.space_id &&
        current && followupSignature(current) === followupSignature(row) ? current : null;
    }
    dependencyList(rows, reviewed = false) {
      return el('ul', { class: 'assistant-dependencies' }, rows.map((dependency) => el('li', {},
        el('div', { class: 'row between' }, el('code', { text: dependency.capability }), el('span', { class: 'small dim', text: dependencyLabels[dependency.availability] })),
        dependency.reason_code ? paragraph(dependencyReasons[dependency.reason_code], 'small dim') : null,
        reviewed ? paragraph(dependencyModes[dependency.permission_mode], 'small dim') : null,
        reviewed && dependency.changes.length ? paragraph(dependency.changes.map((change) => dependencyChanges[change]).join(' · '), 'small') : null)));
    }
    async loadResumeReview(row, button) {
      const epoch = this.scopeVersion, owner = identityKey(), context = this.context;
      const current = () => owner === identityKey() && context === familyContext && this.currentFollowup(row, epoch);
      if (!button.isConnected || !current() || !row.can_review_resume || row.dependency_state !== 'bound' || row.expires_at <= Date.now() ||
          this.pending.has('responsibility-' + row.id) || this.followupNeedsReload.has(row.id)) return;
      const hadFocus = document.activeElement === button;
      const entry = { signature: followupSignature(row), phase: 'loading', data: null, message: '' };
      this.followupReviews.set(row.id, entry); this.backgroundSignature = ''; this.renderBackground();
      try {
        const review = await this.request('GET', 'responsibilities/' + pathId(row.id) + '/resume-review?space_id=' + pathId(row.space_id));
        if (!current() || this.followupReviews.get(row.id) !== entry || entry.phase !== 'loading' || row.expires_at <= Date.now()) return;
        if (!validResumeReview(review, row, this.snapshot.user.id)) throw new Error('The dependency review could not be verified. Reload it before resuming.');
        entry.phase = 'ready'; entry.data = review;
      } catch (error) {
        if (!current() || this.followupReviews.get(row.id) !== entry || error instanceof Stale) return;
        entry.phase = 'error'; entry.data = null; entry.message = error.message;
      }
      if (!current() || this.followupReviews.get(row.id) !== entry) return;
      this.backgroundSignature = ''; this.renderBackground();
      if (hadFocus && entry.data?.can_resume) this.body.querySelector('[data-focus-key="resume-' + row.id + '"]')?.focus({ preventScroll: true });
    }
    async controlFollowup(row, status, button, review = null) {
      const epoch = this.scopeVersion, owner = identityKey(), context = this.context;
      const current = () => this.live() && owner === identityKey() && context === familyContext && this.scopeVersion === epoch && this.scope === row.space_id;
      const operation = 'responsibility-' + row.id;
      if (!button.isConnected || !this.currentFollowup(row, epoch) || this.pending.has(operation) || this.followupNeedsReload.has(row.id)) return;
      if ((status === 'paused' && !row.can_pause) || (status === 'cancelled' && !row.can_cancel) ||
          (status === 'active' && (!row.can_review_resume || row.owner_id !== this.snapshot.user.id || row.expires_at <= Date.now()))) return;
      const body = { status, revision: row.revision };
      if (status === 'active' && row.dependency_state === 'bound') {
        if (!review || this.followupReviews.get(row.id) !== review || review.phase !== 'ready' ||
            !validResumeReview(review.data, row, this.snapshot.user.id) || !review.data.can_resume) return;
        body.dependency_review_digest = review.data.review_digest;
      }
      const hadFocus = document.activeElement === button;
      this.followupReviews.delete(row.id); this.followupNeedsReload.add(row.id);
      this.pending.add(operation); this.stateVersion++; this.backgroundSignature = ''; this.renderBackground();
      let failure = null;
      try {
        const result = await this.request('POST', 'responsibilities/' + pathId(row.id), body);
        if (!result || Object.keys(result).length !== 1 || result.ok !== true) throw new Error('The follow-up result was not confirmed.');
      } catch (error) { failure = error; }
      finally { this.pending.delete(operation); }
      if (!current()) return;
      this.backgroundSignature = '';
      try {
        await this.refresh();
        if (!current()) return;
        this.announce(failure ? 'The action was not confirmed. The current state is shown; no action was repeated. ' + failure.message : 'Follow-up updated.');
      } catch (error) {
        if (current()) this.error(error);
      }
      if (current() && hadFocus && (!document.activeElement || document.activeElement === document.body)) {
        (this.body.querySelector('[data-followup-id="' + row.id + '"]') || this.body).focus({ preventScroll: true });
      }
    }
    followupCard(row) {
      const epoch = this.scopeVersion;
      const busy = this.pending.has('responsibility-' + row.id) || this.followupNeedsReload.has(row.id);
      const expired = row.expires_at <= Date.now();
      const entry = this.followupReviews.get(row.id);
      const action = (label, status, key, review = null) => {
        const button = el('button', { class: 'btn', type: 'button', text: label, 'data-focus-key': key + '-' + row.id,
          'data-operation': 'responsibility-' + row.id, disabled: busy,
          onclick: () => { if (this.currentFollowup(row, epoch)) this.controlFollowup(row, status, button, review); } });
        return button;
      };
      const reviewButton = (label) => {
        const button = el('button', { class: 'btn', type: 'button', text: label, 'data-focus-key': 'review-' + row.id,
          disabled: busy || expired || entry?.phase === 'loading', onclick: () => { if (this.currentFollowup(row, epoch)) this.loadResumeReview(row, button); } });
        return button;
      };
      const controls = el('div', { class: 'row assistant-followup-actions' },
        row.can_pause ? action('Pause', 'paused', 'pause') : null,
        row.can_review_resume && !expired ? (row.dependency_state === 'legacy_unbound' ? action('Resume', 'active', 'pause') : reviewButton('Review dependencies')) : null,
        row.can_cancel ? action('Cancel follow-up', 'cancelled', 'cancel') : null);
      let reviewPanel = null;
      if (entry) {
        reviewPanel = el('section', { class: 'assistant-followup-review', 'aria-label': 'Dependency review for ' + row.title }, el('h4', { text: 'Current dependencies' }));
        if (entry.phase === 'loading') reviewPanel.append(paragraph('Loading the current dependency review…', 'small dim'));
        else if (entry.data) {
          const value = entry.data;
          reviewPanel.append(this.dependencyList(value.dependencies, true),
            paragraph(value.remaining_checks + ' checks left · expires ' + dateTime(value.expires_at), 'small dim'),
            paragraph('Resuming accepts the changes shown here. It does not grant new permissions, extend the expiry or add checks. Actions set to Ask or verified current request can still require separate approval.', 'small dim'));
          if (value.current_job?.status === 'waiting_dependency') reviewPanel.append(paragraph('This check will continue where it stopped. Resume does not spend another check.', 'small dim'));
          if (value.can_resume && !expired) reviewPanel.append(action('Resume follow-up', 'active', 'resume', entry));
          else reviewPanel.append(paragraph(dependencyReasons[value.block_reason] || 'This follow-up cannot resume.', 'small dim'));
        } else {
          reviewPanel.append(paragraph(entry.message || 'This review changed. Load a current review before resuming.', 'small dim'));
          if (row.can_review_resume && !expired) reviewPanel.append(reviewButton('Review dependencies again'));
        }
      }
      let label = followupLabels[row.status];
      if (row.status === 'active' && row.availability === 'waiting') label = 'Waiting for connection';
      return el('article', { class: 'panel cut assistant-followup', 'data-followup-id': row.id, tabindex: -1 },
        el('div', { class: 'row between' }, el('h3', { text: row.title }), el('span', { class: 'small dim', text: label })),
        row.block_reason ? paragraph(dependencyReasons[row.block_reason], 'small') : null,
        paragraph(row.remaining_checks + ' checks left · expires ' + dateTime(row.expires_at), 'small dim'),
        paragraph((row.availability === 'waiting' ? 'Originally due: ' : 'Next check: ') + dateTime(row.next_check_at), 'small dim'),
        row.current_job ? paragraph(row.current_job.block_reason === 'unresolved_effect' ? dependencyReasons.unresolved_effect :
          row.current_job.status === 'waiting_dependency' ? 'This check will continue where it stopped.' :
          row.current_job.status === 'waiting_approval' ? 'The current check is waiting for your permission.' : 'Current check: ' + row.current_job.status.replaceAll('_', ' '), 'small dim') : null,
        el('details', { 'data-key': row.id }, el('summary', { text: 'Scope, tools and limits' }),
          paragraph(row.instruction, ''), paragraph('Why: ' + row.reason, 'small dim'), paragraph('Stop when: ' + row.stop_condition, 'small dim'),
          paragraph('Event: ' + (row.event_kind || 'None') + (row.event_resource ? ' · ' + row.event_resource : ''), 'small dim'),
          row.next_probe_at !== null ? paragraph('Scheduler recheck: ' + dateTime(row.next_probe_at) + '. This checks saved status; it does not reconnect the service.', 'small dim') : null,
          row.current_job?.status === 'waiting_dependency' ? paragraph('This queued check has already used one budget entry. Its receipts and event input are retained.', 'small dim') :
            row.availability === 'waiting' && !row.current_job ? paragraph('Waiting before a check is queued preserves its budget and pending events.', 'small dim') : null,
          row.dependency_state === 'bound' ? this.dependencyList(row.dependencies) : paragraph('Dependencies not recorded. This older follow-up keeps its original scheduling behavior.', 'small dim')),
        controls, busy ? paragraph('Checking the current result…', 'small dim') : null, reviewPanel);
    }
    renderBackground() {
      const snapshot = this.snapshot;
      if (this.tab === 'background' && !this.backgroundVerified) return;
      const scoped = (name) => list(snapshot[name]).filter((row) => row.space_id === this.scope);
      for (const [id, entry] of this.followupReviews) {
        const row = scoped('responsibilities').find((item) => item.id === id);
        if (!row || row.dependency_state !== 'bound' || !row.can_review_resume) { this.followupReviews.delete(id); continue; }
        if (entry.signature !== followupSignature(row) || row.expires_at <= Date.now()) {
          entry.phase = 'stale'; entry.data = null; entry.message = row.expires_at <= Date.now() ? 'This follow-up expired.' : 'This follow-up changed. Review its current dependencies again.';
        }
      }
      const signature = JSON.stringify([this.tab, this.scope, snapshot.approvals, snapshot.responsibilities, snapshot.jobs, snapshot.preferences, snapshot.notices,
        list(snapshot.approvals).map((a) => a.expires_at <= Date.now()), scoped('responsibilities').map((row) => row.expires_at <= Date.now()),
        Array.from(this.pending), Array.from(this.followupReviews), Array.from(this.followupNeedsReload), Array.from(this.approvalNeedsReload)]);
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
            const available = approval.dependency_blocked === false && !this.approvalNeedsReload.has(approval.id);
            const canDecide = (approve) => {
              const current = list(this.snapshot?.approvals).find((row) => row.id === approval.id && row.space_id === this.scope);
              return this.backgroundVerified && current?.status === 'pending' && current.dependency_blocked === false &&
                !this.approvalNeedsReload.has(approval.id) && current.expires_at === approval.expires_at && current.arguments === approval.arguments &&
                current.action_digest === approval.action_digest && (!approve || current.expires_at > Date.now());
            };
            return el('article', { class: 'panel cut assistant-approval', 'data-approval-id': approval.id }, el('h3', { text: approval.capability }),
              paragraph('Allow once authorises only the exact action below. It does not change your standing permissions.', 'small dim'),
              el('pre', { class: 'assistant-arguments', tabindex: 0, 'aria-label': 'Exact action arguments', text: prettyArgs(approval.arguments) }),
              paragraph((expired ? 'Expired ' : 'Expires ') + dateTime(approval.expires_at), 'small dim'),
              approval.dependency_blocked === true ? paragraph('Waiting for a required tool before this request can be decided. Its original expiry still applies.', 'small dim') :
                !available ? paragraph('This request’s availability could not be verified. Reload its current state before deciding.', 'small dim') : null,
              expired ? paragraph('This request can no longer be approved.', 'small dim') : null,
              available ? el('div', { class: 'row' }, expired ? null :
                this.action('Allow once', 'allow-' + approval.id, 'approvals/' + pathId(approval.id), { approve: true }, 'btn pri', () => canDecide(true)),
                this.action('Deny', 'deny-' + approval.id, 'approvals/' + pathId(approval.id), { approve: false }, 'btn', () => canDecide(false))) : null);
          }) : paragraph('No permission requests waiting.', 'small dim')),
        el('section', { class: 'assistant-records', 'aria-label': 'Follow-ups' }, el('h3', { text: 'Follow-ups' }),
          responsibilities.length ? responsibilities.map((row) => this.followupCard(row)) :
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

  async function page(tab, conversationId) {
    leave();
    identity(S.me?.id);
    const view = new View(tab); active = view;
    if (tab === 'conversation') {
      view.initialConversation = /^[A-Za-z0-9_-]{1,128}$/.test(conversationId || '') ? conversationId : 'invalid-conversation-reference';
    }
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
