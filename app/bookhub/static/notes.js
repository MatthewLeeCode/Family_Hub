/* Notes presents the household domain service. Drafts are temporary, never a second notes store. */
'use strict';

const NotesUI = (() => {
  let active = null;
  let owner = null;
  let context = null;
  let epoch = 0;
  let selectedScope = '';
  const drafts = new Map();
  const selections = new Map();
  const key = (scope, id) => scope + ':' + (id || 'new');
  const path = (scope, id = '') => '/api/notes/scopes/' + encodeURIComponent(scope) + '/notes' + (id ? '/' + encodeURIComponent(id) : '');
  const text = (value, cls = 'dim') => el('p', { class: cls, text: value });
  const bytes = (value) => new TextEncoder().encode(value).length;
  const dirty = (draft) => !draft.base ? !!(draft.title || draft.body) : draft.title !== draft.base.title || draft.body !== draft.base.body;
  const updated = (at) => Number.isFinite(at) ? new Date(at).toLocaleString() : '';

  function clear() { epoch++; drafts.clear(); selections.clear(); selectedScope = ''; }
  function leave() { active?.stop(); active?.root.remove(); active = null; }
  function identity(profile, nextContext) {
    if (owner !== profile || context !== nextContext) { leave(); clear(); owner = profile; context = nextContext; }
  }
  function sessionChanged() {
    clear(); context = null;
    active?.sessionChanged();
  }
  function fromNote(note) {
    return { scope: note.space_id, id: note.id, base: note, title: note.title, body: note.body, operation: null, conflict: null, error: '' };
  }
  function keepFocus(node, render) {
    const focused = node.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused?.dataset.focusKey;
    const selection = focused && typeof focused.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd] : null;
    render();
    if (!focusKey) return;
    const next = Array.from(node.querySelectorAll('[data-focus-key]')).find((item) => item.dataset.focusKey === focusKey && !item.disabled);
    (next || node).focus({ preventScroll: true });
    if (selection && next && typeof next.setSelectionRange === 'function') next.setSelectionRange(...selection);
  }

  class View {
    constructor() {
      this.context = context; this.epoch = epoch; this.alive = true;
      this.scope = ''; this.scopes = []; this.notes = []; this.next = null; this.draft = null;
      this.listVersion = 0; this.selectionVersion = 0; this.searchTimer = null;
      this.root = el('div', { class: 'notes-view', tabindex: -1 });
      this.notice = el('p', { class: 'notes-notice small', role: 'status', 'aria-live': 'polite' });
      this.body = el('div', { class: 'notes-body' });
      fill(this.root, this.notice, this.body); setMain(this.root);
    }
    live() { return this.alive && this.root.isConnected && this.epoch === epoch && this.context === context; }
    stop() { this.alive = false; clearTimeout(this.searchTimer); this.listVersion++; this.selectionVersion++; }
    sessionChanged() {
      this.stop(); this.notes = []; this.scopes = []; this.draft = null;
      fill(this.notice);
      fill(this.body, el('h1', { text: 'Your sign-in changed' }),
        text('Reload Family Hub before continuing. Previous notes and unsaved edits have been cleared from this view.'),
        el('button', { class: 'btn pri', type: 'button', text: 'Reload Family Hub', onclick: () => route() }));
    }
    async request(method, url, body, afterUnmount = false) {
      const current = () => this.epoch === epoch && this.context === context && (afterUnmount || this.live());
      if (!this.context || !current()) throw new Stale('sign-in changed');
      try { return await api(method, url, body, current, { 'X-Assistant-Context': this.context }); }
      catch (error) {
        if (!current()) throw new Stale('moved on');
        if (error.status === 401 || error.code === 'assistant_session_changed') {
          sessionChanged(); AssistantUI.sessionChanged(); throw new Stale('sign-in changed');
        }
        throw error;
      }
    }
    announce(message, bad = false) { if (this.live()) { this.notice.textContent = message; this.notice.classList.toggle('bad', bad); } }
    error(error) { if (!(error instanceof Stale)) this.announce(error.message, true); }
    async start() {
      if (!this.context || S.me?.guest || S.me?.via_admin) {
        fill(this.body, el('h1', { text: 'Sign in as yourself' }), text('Notes is available after signing directly into your own Family Hub profile.'));
        return;
      }
      try {
        const status = await this.request('GET', '/api/notes/status');
        if (!status.configured || !status.active) {
          fill(this.body, el('h1', { text: 'Notes' }), text(status.configured ? 'Notes is not ready in this Family Hub yet.' : 'Notes has not been connected to this Family Hub yet.'),
            text('Your existing notes stay in their current location until Notes is enabled.', 'small dim'));
          return;
        }
        const result = await this.request('GET', '/api/notes/scopes');
        this.scopes = (Array.isArray(result.scopes) ? result.scopes : []).filter((scope) =>
          typeof scope.id === 'string' && ['private', 'shared'].includes(scope.kind) && ['editor', 'viewer'].includes(scope.role));
        if (!this.scopes.length) { fill(this.body, el('h1', { text: 'Notes' }), text('No notes workspaces are available for this account.')); return; }
        this.scope = this.scopes.some((scope) => scope.id === selectedScope) ? selectedScope : (this.scopes.find((scope) => scope.kind === 'private') || this.scopes[0]).id;
        selectedScope = this.scope; this.build(); await this.loadList();
        const chosen = selections.get(this.scope);
        if (chosen === 'new' && drafts.has(key(this.scope, ''))) this.newNote(false);
        else if (chosen) await this.selectNote(chosen, false);
      } catch (error) {
        if (!this.live() || error instanceof Stale) return;
        fill(this.body, el('h1', { text: 'Notes unavailable' }), text('Your other Family Hub features are still available.'),
          el('button', { class: 'btn', type: 'button', text: 'Try again', onclick: () => this.start() }));
        this.error(error);
      }
    }
    canEdit() { return this.scopes.find((scope) => scope.id === this.scope)?.role === 'editor'; }
    build() {
      this.scopeSelect = el('select', { 'aria-label': 'Notes workspace', onchange: () => this.switchScope(this.scopeSelect.value) },
        this.scopes.map((scope) => el('option', { value: scope.id, text: scope.name + (scope.kind === 'private' ? ' · Private' : ' · Shared') })));
      this.scopeSelect.value = this.scope;
      this.newButton = el('button', { class: 'btn pri', type: 'button', text: 'New note', onclick: () => this.newNote() });
      this.newButton.hidden = !this.canEdit();
      this.search = el('input', { type: 'search', placeholder: 'Search notes', 'aria-label': 'Search notes', maxlength: 240, oninput: () => {
        this.listVersion++; clearTimeout(this.searchTimer); this.searchTimer = setTimeout(() => this.loadList().catch((error) => this.error(error)), 250);
      } });
      this.list = el('div', { class: 'notes-list', tabindex: -1, 'aria-label': 'Notes in this workspace' });
      this.more = el('button', { class: 'btn sm', type: 'button', text: 'Load more', onclick: () => this.loadList(true).catch((error) => this.error(error)) });
      this.more.hidden = true;
      this.editor = el('section', { class: 'notes-editor panel', tabindex: -1, 'aria-label': 'Note editor' });
      fill(this.body, el('div', { class: 'notes-heading' }, el('h1', { text: 'Notes' }), el('div', { class: 'row' }, field('Workspace', this.scopeSelect), this.newButton)),
        el('div', { class: 'notes-layout' }, el('aside', { class: 'notes-index', 'aria-label': 'Browse notes' }, this.search, this.list, this.more), this.editor));
      this.renderEditor();
    }
    async switchScope(scope) {
      if (!this.scopes.some((item) => item.id === scope) || scope === this.scope) return;
      clearTimeout(this.searchTimer); this.selectionVersion++; this.scope = scope; selectedScope = scope;
      this.draft = null; this.notes = []; this.next = null; this.search.value = ''; this.newButton.hidden = !this.canEdit();
      fill(this.notice); this.renderList(); this.renderEditor();
      try {
        await this.loadList();
        if (this.scope !== scope) return;
        const chosen = selections.get(scope);
        if (chosen === 'new' && drafts.has(key(scope, ''))) this.newNote(false);
        else if (chosen) await this.selectNote(chosen, false);
      } catch (error) { this.error(error); }
    }
    async loadList(more = false) {
      if (!this.live()) return;
      const scope = this.scope, version = ++this.listVersion;
      const query = { q: this.search.value.trim(), cursor: more ? this.next : '' };
      this.more.disabled = true; this.list.setAttribute('aria-busy', 'true');
      try {
        const result = await this.request('GET', path(scope) + '?' + qs(query));
        if (scope !== this.scope || version !== this.listVersion) return;
        const incoming = (Array.isArray(result.notes) ? result.notes : []).filter((note) => note.space_id === scope);
        this.notes = Array.from(new Map((more ? [...this.notes, ...incoming] : incoming).map((note) => [note.id, note])).values());
        this.next = result.next_cursor || null; this.renderList();
        if (more && !this.next && document.activeElement === this.more) this.list.focus({ preventScroll: true });
      } finally {
        if (this.live() && version === this.listVersion) { this.more.disabled = false; this.list.removeAttribute('aria-busy'); }
      }
    }
    renderList() {
      if (!this.list) return;
      keepFocus(this.list, () => {
        const unsaved = drafts.get(key(this.scope, ''));
        fill(this.list, unsaved ? el('button', { class: 'notes-entry', type: 'button', 'data-focus-key': 'new',
          'aria-current': this.draft === unsaved ? 'true' : null, onclick: () => this.newNote() },
          el('strong', { text: unsaved.title || 'New note' }), el('span', { class: 'small dim', text: 'Unsaved note' })) : null,
        this.notes.map((note) => el('button', { class: 'notes-entry', type: 'button', 'data-focus-key': note.id,
          'aria-current': this.draft?.id === note.id ? 'true' : null, onclick: () => this.selectNote(note.id).catch((error) => this.error(error)) },
          el('strong', { text: note.title }), el('span', { class: 'notes-preview dim', text: note.preview }),
          el('span', { class: 'small dim', text: dirty(drafts.get(key(this.scope, note.id)) || { title: '', body: '', base: { title: '', body: '' } }) ? 'Unsaved changes' : updated(note.updated_at) }))),
        !this.notes.length && !unsaved ? text(this.search.value ? 'No notes match your search.' : 'No notes here yet.', 'small dim') : null);
      });
      this.more.hidden = !this.next;
    }
    newNote(focus = true) {
      if (!this.canEdit()) return;
      this.selectionVersion++;
      let draft = drafts.get(key(this.scope, ''));
      if (!draft) { draft = { scope: this.scope, id: '', base: null, title: '', body: '', operation: null, conflict: null, error: '' }; drafts.set(key(this.scope, ''), draft); }
      this.draft = draft; selections.set(this.scope, 'new'); fill(this.notice); this.renderList(); this.renderEditor();
      if (focus) this.titleInput?.focus();
    }
    async selectNote(id, focus = true) {
      const scope = this.scope, version = ++this.selectionVersion;
      const cached = drafts.get(key(scope, id));
      if (cached && (dirty(cached) || cached.operation || cached.conflict)) {
        this.draft = cached;
      } else {
        // Do not leave the previous note editable while a different note loads.
        this.draft = null; this.titleInput = null; this.bodyInput = null;
        this.renderList(); fill(this.editor, text('Loading note…', 'small dim'));
        let result;
        try { result = await this.request('GET', path(scope, id)); }
        catch (error) { if (this.live() && version === this.selectionVersion) this.renderEditor(); throw error; }
        if (scope !== this.scope || version !== this.selectionVersion) return;
        if (result.note?.space_id !== scope || result.note?.id !== id) throw new Error('The note could not be loaded.');
        this.draft = fromNote(result.note); drafts.set(key(scope, id), this.draft);
      }
      selections.set(scope, id); fill(this.notice); this.renderList(); this.renderEditor();
      if (focus) this.titleInput?.focus();
    }
    renderEditor() {
      if (!this.editor) return;
      keepFocus(this.editor, () => {
        const draft = this.draft;
        if (!draft) { fill(this.editor, el('h2', { text: 'A place for the details' }), text('Choose a note' + (this.canEdit() ? ' or start a new one.' : ' to read it.'))); return; }
        const locked = !!draft.operation || !this.canEdit();
        this.titleInput = el('input', { type: 'text', value: draft.title, maxlength: 240, required: true, readonly: locked, 'data-focus-key': 'title' });
        this.bodyInput = el('textarea', { value: draft.body, maxlength: 16000, rows: 14, readonly: locked, 'data-focus-key': 'body' });
        const titleInput = this.titleInput, bodyInput = this.bodyInput;
        const save = el('button', { class: 'btn pri', type: 'submit', text: draft.id ? 'Save changes' : 'Create note', 'data-focus-key': 'save' });
        const state = el('span', { class: 'small dim', role: 'status' });
        const changed = () => {
          draft.title = titleInput.value; draft.body = bodyInput.value;
          save.disabled = locked || !!draft.conflict || !dirty(draft);
          state.textContent = dirty(draft) ? 'Unsaved changes' : draft.base ? 'Saved · ' + updated(draft.base.updated_at) : 'New note';
        };
        this.titleInput.addEventListener('input', changed); this.bodyInput.addEventListener('input', changed); changed();
        const form = el('form', { class: 'notes-form', onsubmit: (event) => { event.preventDefault(); this.save(draft); }, onkeydown: (event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (!save.disabled) this.save(draft); }
        } }, field('Title', this.titleInput), field('Note', this.bodyInput),
          el('div', { class: 'row notes-actions' }, this.canEdit() ? save : null, state));
        const remove = draft.id && this.canEdit() && !draft.operation && !draft.conflict ? el('details', { class: 'notes-delete' },
          el('summary', { text: 'Delete note' }), text('Delete this note from the workspace? It will be removed from the notes list.', 'small dim'),
          el('button', { class: 'btn sm', type: 'button', text: 'Delete note', 'data-focus-key': 'delete', onclick: () => this.remove(draft) })) : null;
        fill(this.editor, !this.canEdit() ? text('You can read notes in this workspace.', 'small dim') : null,
          draft.error ? el('p', { class: 'bad small', role: 'alert', text: draft.error }) : null,
          draft.operation ? this.operationNotice(draft) : null,
          draft.conflict ? this.conflictNotice(draft) : null, form, remove);
      });
    }
    operationNotice(draft) {
      const pending = draft.operation.phase === 'sending';
      if (draft.operation.phase === 'blocked') return el('div', { class: 'notes-callout', role: 'alert' },
        text('This change could not be matched safely to a saved result.', 'small'),
        text('Reload Notes to review the saved version before making another change. Unsaved text in this page will be cleared.', 'small dim'),
        el('button', { class: 'btn sm', type: 'button', text: 'Reload Notes', onclick: () => location.reload() }));
      return el('div', { class: 'notes-callout', role: 'status' }, text(pending ? 'Saving…' : 'The result of this change is not confirmed.', 'small'),
        !pending ? text('Retry checks the same change. Your text stays locked until its result is known.', 'small dim') : null,
        !pending ? el('button', { class: 'btn sm', type: 'button', text: 'Retry same change', 'data-focus-key': 'retry', onclick: () => this.send(draft) }) : null);
    }
    conflictNotice(draft) {
      const latest = draft.conflict.latest;
      return el('div', { class: 'notes-callout', role: 'status' }, el('strong', { text: 'This note changed elsewhere' }),
        text('Your edit is kept below. Read the latest version before applying your edit again.', 'small dim'),
        latest ? el('details', { open: true }, el('summary', { text: 'Latest saved version · ' + updated(latest.updated_at) }),
          el('h3', { text: latest.title }), el('p', { class: 'notes-latest', text: latest.body })) : null,
        el('div', { class: 'row' }, !latest ? el('button', { class: 'btn sm', type: 'button', text: 'Read latest version', 'data-focus-key': 'latest', onclick: () => this.readLatest(draft) }) : null,
          latest ? el('button', { class: 'btn sm', type: 'button', text: 'Use latest version', onclick: () => {
            draft.base = latest; draft.title = latest.title; draft.body = latest.body; draft.conflict = null; draft.error = ''; this.renderEditor();
          } }) : null,
          latest ? el('button', { class: 'btn sm', type: 'button', text: 'Keep my edit for review', onclick: () => {
            draft.base = latest; draft.conflict = null; draft.error = ''; this.renderEditor(); this.announce('Your edit is ready to review. Save changes when you are ready.');
          } }) : null));
    }
    async readLatest(draft) {
      try {
        const result = await this.request('GET', path(draft.scope, draft.id));
        if (this.draft !== draft || !draft.conflict) return;
        if (result.note?.space_id !== draft.scope || result.note?.id !== draft.id) throw new Error('The latest version could not be loaded.');
        draft.conflict.latest = result.note; this.renderEditor();
      } catch (error) { this.error(error); }
    }
    save(draft) {
      if (this.draft !== draft || !this.canEdit() || draft.operation || draft.conflict || !dirty(draft)) return;
      const title = draft.title.trim();
      if (!title || bytes(title) > 240 || bytes(draft.body) > 16000) {
        draft.error = !title ? 'Give this note a title.' : bytes(title) > 240 ? 'This title is too long. Shorten it and try again.' : 'This note is too long. Shorten it and try again.';
        this.renderEditor(); return;
      }
      this.begin(draft, draft.id ? 'PUT' : 'POST', { title, body: draft.body, ...(draft.id ? { revision: draft.base.revision } : {}) });
    }
    remove(draft) {
      if (this.draft !== draft || !this.canEdit() || !draft.id || draft.operation || draft.conflict) return;
      this.begin(draft, 'DELETE', { revision: draft.base.revision });
    }
    begin(draft, method, payload) {
      if (!globalThis.crypto?.randomUUID) { draft.error = 'A secure connection is required before saving notes.'; this.renderEditor(); return; }
      this.announce('');
      draft.error = '';
      draft.operation = { method, url: path(draft.scope, draft.id), payload: Object.freeze({ ...payload, request_id: crypto.randomUUID() }), phase: 'ready' };
      this.send(draft);
    }
    async send(draft) {
      const operation = draft.operation;
      if (!operation || operation.phase === 'sending') return;
      operation.phase = 'sending'; draft.error = ''; if (this.draft === draft) this.renderEditor();
      try {
        const result = await this.request(operation.method, operation.url, operation.payload, true);
        const selected = selections.get(draft.scope) === (draft.id || 'new');
        if (operation.method === 'DELETE') {
          drafts.delete(key(draft.scope, draft.id)); if (selected) selections.delete(draft.scope);
          if (active?.draft === draft) active.draft = null;
        } else {
          const note = result.note;
          if (!note || note.space_id !== draft.scope || (draft.id && note.id !== draft.id)) throw new Error('The save result could not be confirmed.');
          drafts.delete(key(draft.scope, draft.id));
          Object.assign(draft, { id: note.id, base: note, title: note.title, body: note.body, conflict: null });
          drafts.set(key(draft.scope, draft.id), draft); if (selected) selections.set(draft.scope, draft.id);
        }
        draft.operation = null;
        if (active?.live() && active.scope === draft.scope) {
          const view = active;
          view.renderEditor(); view.announce(operation.method === 'DELETE' ? 'Note deleted.' : 'Note saved.');
          view.loadList().catch((error) => view.error(error));
        }
      } catch (error) {
        if (error instanceof Stale) return;
        if (error.code === 'revision_conflict') { draft.operation = null; draft.conflict = { latest: null }; }
        else if (error.code === 'idempotency_conflict') { operation.phase = 'blocked'; }
        else if (error.status && error.status >= 400 && error.status < 500) { draft.operation = null; draft.error = error.message; }
        else { operation.phase = 'unknown'; draft.error = 'The connection did not confirm the result. Retry the same change when it is available.'; }
        if (active?.live() && active.draft === draft) active.renderEditor();
      }
    }
  }

  async function page() { leave(); const view = new View(); active = view; await view.start(); }
  return { page, leave, identity, sessionChanged };
})();
