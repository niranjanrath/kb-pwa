import { createDatabase } from './db.js';
import { createFolderService, ROOT_NAME } from './folderService.js';
import { createNoteService, createAutosaver, normalizeTitle } from './noteService.js';
import { createSearchService, splitHighlight } from './searchService.js';
import { createImportExport } from './importExport.js';
import { renderMarkdownInto } from './markdown.js';
import { createTreeView } from './treeView.js';
import { seed } from './sample.js';
import { describeError, KbError } from './errors.js';
import {
  el, icon, hydrateIcons, toast, promptDialog, confirmDialog, alertDialog, selectDialog,
  downloadBlob, formatDateTime, formatTime, isoDay, safeStorage,
} from './ui.js';

const $ = (id) => document.getElementById(id);
const store = safeStorage();
const mobileQuery = window.matchMedia('(max-width: 760px)');
const MAX_IMPORT_FILE = 10 * 1024 * 1024;

const state = {
  ready: false,
  tree: null,
  folderMap: new Map(), // id -> tree node
  selected: { type: 'folder', id: null },
  openNote: null, // { id, folderId, updatedAt }
  expanded: new Set(),
  view: 'split',
  theme: 'auto',
  titleDirty: false,
  lastStatus: 'saved',
  installPrompt: null,
};

let db, folders, notes, searchService, io, autosaver, treeView, channel;

// ---------------------------------------------------------------- startup

async function init() {
  hydrateIcons();
  applyTheme(store.get('kb.theme', 'auto'));
  setView(store.get('kb.view', mobileQuery.matches ? 'edit' : 'split'), { persist: false });
  wireStaticEvents();
  registerServiceWorker();

  try {
    db = createDatabase();
    await db.open();
  } catch (err) {
    storageFailed(err);
    return;
  }

  folders = createFolderService(db);
  notes = createNoteService(db);
  searchService = createSearchService(db);
  io = createImportExport({ db, folderService: folders });
  autosaver = createAutosaver(notes, { delay: 600, onStatus: onSaveStatus });
  treeView = createTreeView($('tree'), {
    onActivate: (item, opts) => activateItem(item, opts),
    onToggle: (id) => toggleFolder(id),
    onMove: (item, folderId) => moveItemTo(item, folderId),
    onRename: (item) => renameItem(item),
    onDelete: (item) => deleteItem(item),
  });

  navigator.storage?.persist?.().catch(() => {}); // ask the browser not to evict our data

  try {
    state.expanded = new Set(JSON.parse(store.get('kb.expanded', '[]')).filter(Number.isInteger));
  } catch {
    state.expanded = new Set();
  }

  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel('kb-changes');
    channel.onmessage = onExternalChange;
  }

  state.ready = true;
  try {
    await refresh();
  } catch (err) {
    storageFailed(err);
    return;
  }

  const params = new URLSearchParams(location.search);
  const last = Number(store.get('kb.lastNote', ''));
  if (params.get('action') === 'new-note') {
    history.replaceState(null, '', location.pathname);
    await newNote();
  } else if (Number.isInteger(last) && last > 0 && (await db.notes.get(last))) {
    await openNote(last, { quiet: true });
  } else {
    showFolderView(null);
  }
  updateToolbar();
}

function storageFailed(err) {
  state.ready = false;
  document.body.classList.add('no-storage');
  const banner = $('banner');
  banner.hidden = false;
  banner.textContent = `${describeError(err)} Your notes cannot be loaded or saved in this window. Try a regular (non-private) window, allow site data for this page, or free up disk space.`;
  for (const id of ['btn-new-note', 'btn-new-folder', 'btn-rename', 'btn-move', 'btn-delete', 'search', 'btn-more']) $(id).disabled = true;
  $('folder-view').hidden = false;
  $('folder-view').replaceChildren(
    el('div', { class: 'empty' }, el('h2', {}, 'Browser storage is unavailable'), el('p', {}, 'This app stores everything locally in IndexedDB, which could not be opened.')),
  );
  console.error(err);
}

function registerServiceWorker() {
  const secure = location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (!('serviceWorker' in navigator) || !secure) return;
  navigator.serviceWorker.register('./service-worker.js').catch((err) => console.warn('Service worker registration failed', err));
}

// ---------------------------------------------------------------- data refresh

async function refresh() {
  state.tree = await folders.getTree();
  state.folderMap = new Map();
  const index = (node) => {
    for (const f of node.children) {
      state.folderMap.set(f.id, f);
      index(f);
    }
  };
  index(state.tree);
  // Selection may point at something that was deleted elsewhere.
  if (state.selected.type === 'folder' && state.selected.id != null && !state.folderMap.has(state.selected.id)) state.selected = { type: 'folder', id: null };
  renderTree();
  if (!$('folder-view').hidden) showFolderView(state.selected.type === 'folder' ? state.selected.id : null);
  updateToolbar();
}

function notifyChanged() {
  try {
    channel?.postMessage('changed');
  } catch {
    /* ignore */
  }
}

async function onExternalChange() {
  if (!state.ready) return;
  try {
    await refresh();
    if (state.openNote && !autosaver.hasPending()) {
      const note = await db.notes.get(state.openNote.id);
      if (!note) {
        toast('This note was deleted in another tab.');
        closeEditor();
        showFolderView(note ? note.folderId : null);
      } else if (note.updatedAt > state.openNote.updatedAt) {
        const content = $('note-content');
        const start = content.selectionStart;
        $('note-title').value = note.title;
        content.value = note.content;
        content.setSelectionRange(Math.min(start, note.content.length), Math.min(start, note.content.length));
        state.openNote = { id: note.id, folderId: note.folderId, updatedAt: note.updatedAt };
        renderPreviewNow();
        $('note-modified').textContent = `Modified ${formatDateTime(note.updatedAt)}`;
        renderBreadcrumb(note.folderId);
        toast('Updated from another tab.');
      }
    }
  } catch (err) {
    console.warn(err);
  }
}

// ---------------------------------------------------------------- tree

function emptyTreeNode() {
  const t = state.tree;
  if (t.children.length || t.notes.length) return null;
  return el(
    'div',
    { class: 'tree-empty' },
    el('p', {}, 'Nothing here yet.'),
    el('button', { class: 'btn', type: 'button', onclick: loadSample }, 'Create example structure'),
  );
}

function renderTree() {
  if (!state.tree) return;
  treeView.render(state.tree, { expanded: state.expanded, selected: state.selected, emptyNode: emptyTreeNode() });
}

function persistExpanded() {
  store.set('kb.expanded', JSON.stringify([...state.expanded]));
}

function toggleFolder(id) {
  if (state.expanded.has(id)) state.expanded.delete(id);
  else state.expanded.add(id);
  persistExpanded();
  renderTree();
}

function expandAncestors(folderId, includeSelf = true) {
  let cur = folderId;
  let guard = 0;
  while (cur != null && guard++ < 1000) {
    const node = state.folderMap.get(cur);
    if (!node) break;
    if (includeSelf || cur !== folderId) state.expanded.add(cur);
    cur = node.parentId ?? null;
  }
  persistExpanded();
}

function folderPath(folderId) {
  const out = [];
  let cur = folderId;
  let guard = 0;
  while (cur != null && guard++ < 1000) {
    const node = state.folderMap.get(cur);
    if (!node) break;
    out.unshift(node);
    cur = node.parentId ?? null;
  }
  return out;
}

function currentFolderId() {
  if (state.selected.type === 'folder') return state.selected.id;
  return state.openNote ? state.openNote.folderId : null;
}

async function activateItem(item, { fromClick } = {}) {
  if (item.type === 'note') {
    await openNote(item.id, { fromClick });
  } else {
    await selectFolder(item.id, { expand: true });
    if (fromClick && mobileQuery.matches) closeDrawer();
  }
}

async function selectFolder(id, { expand = false, reveal = false } = {}) {
  await flushQuietly();
  closeEditor();
  state.selected = { type: 'folder', id };
  if (id != null && (expand || reveal)) expandAncestors(id, expand);
  renderTree();
  showFolderView(id);
  updateToolbar();
  if (reveal) treeView.reveal('folder', id);
}

// ---------------------------------------------------------------- folder view (main area)

function showFolderView(id) {
  const node = id == null ? state.tree : state.folderMap.get(id) || state.tree;
  const view = $('folder-view');
  $('editor').hidden = true;
  view.hidden = false;
  $('view-toggle').hidden = true;
  document.title = id == null ? 'Knowledge Base' : `${node.name} – Knowledge Base`;

  const crumbs = folderPath(node.id);
  const heading = el('h2', {}, node.id == null ? ROOT_NAME : node.name);
  const path = el('p', { class: 'muted' }, crumbs.length > 1 ? crumbs.slice(0, -1).map((c) => c.name).join(' / ') : ' ');
  const parts = [el('div', { class: 'fv-head' }, heading, node.id != null ? path : null)];

  if (node.children.length) {
    parts.push(
      el('h3', { class: 'fv-section' }, 'Folders'),
      el('ul', { class: 'item-list' }, ...node.children.map((f) =>
        el('li', {}, el('button', { type: 'button', class: 'item', onclick: () => selectFolder(f.id, { expand: true, reveal: true }) },
          icon('folder', 18), el('span', { class: 'item-title' }, f.name),
          el('span', { class: 'muted' }, `${f.children.length + f.notes.length} item${f.children.length + f.notes.length === 1 ? '' : 's'}`))))),
    );
  }

  if (node.notes.length) {
    parts.push(
      el('h3', { class: 'fv-section' }, 'Notes'),
      el('ul', { class: 'item-list' }, ...node.notes.map((n) =>
        el('li', {}, el('button', { type: 'button', class: 'item', onclick: () => openNote(n.id) },
          icon('note', 18), el('span', { class: 'item-title' }, n.title),
          el('span', { class: 'muted' }, formatDateTime(n.updatedAt)))))),
    );
  } else {
    const wholeKbEmpty = node.id == null && !node.children.length;
    parts.push(
      el('div', { class: 'empty' },
        el('h3', {}, wholeKbEmpty ? 'Your knowledge base is empty' : 'No notes in this folder'),
        el('p', {}, wholeKbEmpty ? 'Capture your first note, or start from an example structure.' : `Create a note in “${node.id == null ? ROOT_NAME : node.name}” to get started.`),
        el('div', { class: 'empty-actions' },
          el('button', { class: 'btn primary', type: 'button', onclick: newNote }, icon('plus'), 'New note'),
          wholeKbEmpty ? el('button', { class: 'btn', type: 'button', onclick: loadSample }, 'Create example structure') : null)),
    );
  }
  view.replaceChildren(...parts);
}

async function loadSample() {
  try {
    await flushQuietly();
    const first = await seed(folders, notes);
    for (const f of await folders.list()) state.expanded.add(f.id);
    persistExpanded();
    await refresh();
    notifyChanged();
    if (first != null) await openNote(first, { quiet: true });
  } catch (err) {
    toastError(err);
  }
}

// ---------------------------------------------------------------- editor

function closeEditor() {
  state.openNote = null;
  state.titleDirty = false;
  $('editor').hidden = true;
  $('view-toggle').hidden = true;
  store.set('kb.lastNote', '');
}

async function openNote(id, { fromClick = false, focusContent = false, quiet = false } = {}) {
  await flushQuietly();
  let note;
  try {
    note = await notes.get(id);
  } catch (err) {
    if (!quiet) toastError(err);
    await refresh();
    return showFolderView(null);
  }
  state.openNote = { id: note.id, folderId: note.folderId, updatedAt: note.updatedAt };
  state.selected = { type: 'note', id: note.id };
  state.titleDirty = false;
  if (note.folderId != null) expandAncestors(note.folderId, true);

  $('folder-view').hidden = true;
  $('editor').hidden = false;
  $('view-toggle').hidden = false;
  $('note-title').value = note.title;
  $('note-content').value = note.content;
  $('note-modified').textContent = `Modified ${formatDateTime(note.updatedAt)}`;
  setSaveStatus('saved', 'All changes saved');
  renderBreadcrumb(note.folderId);
  renderPreviewNow();
  document.title = `${note.title} – Knowledge Base`;
  store.set('kb.lastNote', String(note.id));

  renderTree();
  treeView.reveal('note', note.id);
  updateToolbar();
  if (mobileQuery.matches && fromClick) closeDrawer();
  if (focusContent) $('note-content').focus();
}

function renderBreadcrumb(folderId) {
  const nav = $('breadcrumb');
  const crumbs = [{ id: null, name: ROOT_NAME }, ...folderPath(folderId)];
  nav.replaceChildren(
    ...crumbs
      .flatMap((c, i) => [
        i ? el('span', { class: 'sep', 'aria-hidden': 'true' }, '/') : null,
        el('button', { type: 'button', class: 'crumb', onclick: () => selectFolder(c.id, { reveal: true }) }, c.name),
      ])
      .filter(Boolean),
  );
}

let previewTimer = null;
function renderPreviewSoon() {
  clearTimeout(previewTimer);
  const len = $('note-content').value.length;
  previewTimer = setTimeout(renderPreviewNow, len > 100_000 ? 400 : 80);
}
function renderPreviewNow() {
  clearTimeout(previewTimer);
  renderMarkdownInto($('preview'), $('note-content').value);
}

function setSaveStatus(status, text) {
  const node = $('save-status');
  node.dataset.state = status;
  node.textContent = text;
}

function onSaveStatus(s) {
  const previous = state.lastStatus;
  state.lastStatus = s.state;
  switch (s.state) {
    case 'dirty':
      setSaveStatus('dirty', 'Unsaved changes…');
      break;
    case 'saving':
      setSaveStatus('saving', 'Saving…');
      break;
    case 'saved':
      setSaveStatus('saved', `Saved at ${formatTime(Date.now())}`);
      if (s.note && state.openNote && s.note.id === state.openNote.id) {
        state.openNote.updatedAt = s.note.updatedAt;
        $('note-modified').textContent = `Modified ${formatDateTime(s.note.updatedAt)}`;
      }
      notifyChanged();
      if (state.titleDirty) {
        state.titleDirty = false;
        refresh().catch(() => {}); // re-sort the tree and folder list after a rename
      }
      break;
    case 'error':
      setSaveStatus('error', 'Couldn’t save – retrying…');
      if (previous !== 'error') toast(`Saving failed: ${describeError(s.error)}`, { type: 'error' });
      break;
  }
}

async function flushQuietly() {
  if (!autosaver) return;
  try {
    await autosaver.flush();
  } catch {
    /* the status indicator already reports it; edits stay queued for retry */
  }
}

function onTitleInput() {
  if (!state.openNote) return;
  const value = $('note-title').value;
  autosaver.schedule(state.openNote.id, { title: value });
  state.titleDirty = true;
  treeView.setLabel('note', state.openNote.id, normalizeTitle(value));
  document.title = `${normalizeTitle(value)} – Knowledge Base`;
}

function onContentInput() {
  if (!state.openNote) return;
  autosaver.schedule(state.openNote.id, { content: $('note-content').value });
  renderPreviewSoon();
}

function setView(view, { persist = true } = {}) {
  state.view = view;
  $('editor').dataset.view = view;
  for (const b of $('view-toggle').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.view === view));
  if (persist) store.set('kb.view', view);
}

// ---------------------------------------------------------------- actions

async function newNote() {
  if (!state.ready) return;
  try {
    await flushQuietly();
    const note = await notes.create({ folderId: currentFolderId() });
    if (state.view === 'preview') setView('split');
    await refresh();
    notifyChanged();
    await openNote(note.id, { focusContent: true });
    if (mobileQuery.matches) closeDrawer();
  } catch (err) {
    toastError(err);
  }
}

async function askName({ title, label, value = '', confirmLabel, action }) {
  let error;
  let current = value;
  for (;;) {
    const answer = await promptDialog({ title, label, value: current, confirmLabel, error });
    if (answer == null) return undefined; // cancelled
    try {
      return await action(answer);
    } catch (err) {
      if (err instanceof KbError && ['INVALID_NAME', 'DUPLICATE'].includes(err.code)) {
        error = err.message;
        current = answer;
        continue;
      }
      throw err;
    }
  }
}

async function newFolder() {
  if (!state.ready) return;
  try {
    const parentId = currentFolderId();
    const parentName = parentId == null ? ROOT_NAME : state.folderMap.get(parentId)?.name;
    const created = await askName({
      title: 'New folder',
      label: `Folder name (inside “${parentName}”)`,
      confirmLabel: 'Create',
      action: (name) => folders.create(name, parentId),
    });
    if (!created) return;
    if (parentId != null) expandAncestors(parentId, true);
    await refresh();
    notifyChanged();
    await selectFolder(created.id, { reveal: true });
  } catch (err) {
    toastError(err);
  }
}

const selectedItem = () => ({ type: state.selected.type, id: state.selected.id });

async function renameItem(item = selectedItem()) {
  if (!state.ready || (item.type === 'folder' && item.id == null)) return;
  try {
    await flushQuietly();
    if (item.type === 'note') {
      const note = await notes.get(item.id);
      const updated = await askName({
        title: 'Rename note',
        label: 'Note title',
        value: note.title,
        action: (title) => notes.rename(item.id, title),
      });
      if (!updated) return;
      if (state.openNote?.id === item.id) {
        $('note-title').value = updated.title;
        state.openNote.updatedAt = updated.updatedAt;
        $('note-modified').textContent = `Modified ${formatDateTime(updated.updatedAt)}`;
        document.title = `${updated.title} – Knowledge Base`;
      }
    } else {
      const folder = await folders.get(item.id);
      const updated = await askName({ title: 'Rename folder', label: 'Folder name', value: folder.name, action: (name) => folders.rename(item.id, name) });
      if (!updated) return;
    }
    await refresh();
    notifyChanged();
    if (state.openNote) renderBreadcrumb(state.openNote.folderId);
  } catch (err) {
    toastError(err);
  }
}

async function deleteItem(item = selectedItem()) {
  if (!state.ready || (item.type === 'folder' && item.id == null)) return;
  try {
    await flushQuietly();
    if (item.type === 'note') {
      const note = await notes.get(item.id);
      const ok = await confirmDialog({
        title: 'Delete note?',
        message: `“${note.title}” will be permanently deleted. This cannot be undone.`,
        confirmLabel: 'Delete note',
        danger: true,
      });
      if (!ok) return;
      autosaver.cancel(item.id);
      await notes.remove(item.id);
      const wasOpen = state.openNote?.id === item.id;
      if (wasOpen) closeEditor();
      state.selected = { type: 'folder', id: note.folderId };
      await refresh();
      notifyChanged();
      if (wasOpen || $('editor').hidden) showFolderView(note.folderId);
      toast('Note deleted.');
    } else {
      const folder = await folders.get(item.id);
      const counts = await folders.countContents(item.id);
      const empty = counts.folders === 0 && counts.notes === 0;
      const detail = empty
        ? 'The folder is empty.'
        : `It contains ${counts.notes} note${counts.notes === 1 ? '' : 's'}${counts.folders ? ` and ${counts.folders} subfolder${counts.folders === 1 ? '' : 's'}` : ''}, which will be permanently deleted too.`;
      const ok = await confirmDialog({
        title: 'Delete folder?',
        message: `“${folder.name}” will be deleted. ${detail} This cannot be undone.`,
        confirmLabel: empty ? 'Delete folder' : 'Delete folder and contents',
        danger: true,
      });
      if (!ok) return;
      const openId = state.openNote?.id;
      if (openId != null) autosaver.cancel(openId);
      await folders.remove(item.id, { recursive: !empty });
      state.expanded.delete(item.id);
      if (openId != null && !(await db.notes.get(openId))) closeEditor();
      state.selected = { type: 'folder', id: folder.parentId ?? null };
      await refresh();
      notifyChanged();
      if (!state.openNote) showFolderView(folder.parentId ?? null);
      toast('Folder deleted.');
    }
  } catch (err) {
    toastError(err);
  }
}

async function moveItem(item = selectedItem()) {
  if (!state.ready || (item.type === 'folder' && item.id == null)) return;
  try {
    await flushQuietly();
    const blocked = new Set();
    let current = null;
    if (item.type === 'folder') {
      blocked.add(item.id);
      for (const d of await folders.descendantIds(item.id)) blocked.add(d);
      current = state.folderMap.get(item.id)?.parentId ?? null;
    } else {
      current = (await notes.get(item.id)).folderId;
    }
    const all = [...state.folderMap.values()].map((f) => ({ id: f.id, path: folderPath(f.id).map((p) => p.name).join(' / ') }));
    all.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
    const choice = await selectDialog({
      title: item.type === 'note' ? 'Move note' : 'Move folder',
      label: 'Destination folder',
      value: current ?? '',
      options: [{ value: '', label: ROOT_NAME }, ...all.map((f) => ({ value: f.id, label: f.path, disabled: blocked.has(f.id) }))],
    });
    if (choice == null) return;
    await moveItemTo(item, choice === '' ? null : Number(choice));
  } catch (err) {
    toastError(err);
  }
}

async function moveItemTo(item, targetFolderId) {
  try {
    await flushQuietly();
    if (item.type === 'note') {
      const moved = await notes.move(item.id, targetFolderId);
      if (state.openNote?.id === item.id) {
        state.openNote.folderId = moved.folderId;
        state.openNote.updatedAt = moved.updatedAt;
      }
    } else {
      await folders.move(item.id, targetFolderId);
    }
    if (targetFolderId != null) expandAncestors(targetFolderId, true);
    await refresh();
    notifyChanged();
    if (state.openNote) renderBreadcrumb(state.openNote.folderId);
    treeView.reveal(item.type, item.id);
  } catch (err) {
    toastError(err);
  }
}

function toastError(err) {
  console.error(err);
  toast(describeError(err), { type: 'error' });
}

// ---------------------------------------------------------------- search

let searchToken = 0;
let searchTimer = null;

function onSearchInput() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 120);
}

async function runSearch() {
  const query = $('search').value;
  const token = ++searchToken;
  const results = $('search-results');
  if (!query.trim()) {
    results.hidden = true;
    $('tree').hidden = false;
    return;
  }
  await flushQuietly(); // include unsaved edits in the results
  let found;
  try {
    found = await searchService.search(query);
  } catch (err) {
    return toastError(err);
  }
  if (token !== searchToken) return; // a newer query superseded this one
  renderResults(found, query.trim());
  $('tree').hidden = true;
  results.hidden = false;
}

function highlighted(text, terms, tag = 'span', cls = '') {
  const node = el(tag, { class: cls });
  for (const seg of splitHighlight(text, terms)) node.append(seg.match ? el('mark', {}, seg.text) : seg.text);
  return node;
}

function renderResults(found, query) {
  const box = $('search-results');
  const total = found.notes.length + found.folders.length;
  const status = el('p', { class: 'sr-only', role: 'status' }, total ? `${found.notes.length} notes and ${found.folders.length} folders found` : 'No results');
  if (!total) {
    box.replaceChildren(status, el('p', { class: 'results-empty' }, `No matches for “${query}”.`));
    return;
  }
  const parts = [status];
  if (found.folders.length) {
    parts.push(
      el('h2', { class: 'results-heading' }, 'Folders'),
      ...found.folders.map((f) =>
        el('button', { type: 'button', class: 'result', onclick: () => pickResult({ type: 'folder', id: f.id }) },
          el('span', { class: 'result-title' }, icon('folder', 15), highlighted(f.name, found.terms)),
          el('span', { class: 'result-path' }, [ROOT_NAME, ...f.path].join(' / ')))),
    );
  }
  if (found.notes.length) {
    parts.push(
      el('h2', { class: 'results-heading' }, `Notes (${found.notes.length}${found.truncated ? '+' : ''})`),
      ...found.notes.map((n) =>
        el('button', { type: 'button', class: 'result', onclick: () => pickResult({ type: 'note', id: n.id }) },
          el('span', { class: 'result-title' }, icon('note', 15), highlighted(n.title, found.terms)),
          el('span', { class: 'result-path' }, [ROOT_NAME, ...n.path].join(' / ')),
          n.snippet ? highlighted(n.snippet, found.terms, 'span', 'result-snippet') : null)),
    );
  }
  box.replaceChildren(...parts);
}

async function pickResult(result) {
  clearSearch();
  if (result.type === 'note') await openNote(result.id, { fromClick: true });
  else {
    await selectFolder(result.id, { expand: true, reveal: true });
    if (mobileQuery.matches) closeDrawer();
  }
}

function clearSearch() {
  $('search').value = '';
  searchToken++;
  clearTimeout(searchTimer);
  $('search-results').hidden = true;
  $('tree').hidden = false;
}

// ---------------------------------------------------------------- import / export

async function importMarkdown(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  try {
    await flushQuietly();
    const items = [];
    const ignored = [];
    for (const f of files) {
      if (f.size > MAX_IMPORT_FILE) ignored.push(`${f.name}: file too large (max 10 MB)`);
      else items.push({ name: f.name, text: await f.text() });
    }
    const report = await io.importMarkdownFiles(items, currentFolderId());
    report.ignored.push(...ignored);
    await afterImport(report);
  } catch (err) {
    toastError(err);
  }
}

async function importZipFile(file) {
  if (!file) return;
  try {
    await flushQuietly();
    const report = await io.importZip(await file.arrayBuffer(), { targetFolderId: currentFolderId() });
    await afterImport(report);
  } catch (err) {
    if (err instanceof KbError) await alertDialog({ title: 'Import failed', lines: [err.message, 'Nothing was imported.'] });
    else toastError(err);
  }
}

async function afterImport(report) {
  await refresh();
  notifyChanged();
  const lines = [`${report.notesCreated} note${report.notesCreated === 1 ? '' : 's'} imported, ${report.foldersCreated} folder${report.foldersCreated === 1 ? '' : 's'} created.`];
  if (report.notesSkipped) lines.push(`${report.notesSkipped} identical note${report.notesSkipped === 1 ? ' was' : 's were'} already present and skipped.`);
  if (report.renamed) lines.push(`${report.renamed} note${report.renamed === 1 ? ' was' : 's were'} renamed with a number because a different note had the same title.`);
  await alertDialog({ title: 'Import finished', lines, details: report.ignored });
}

async function exportCurrentNote() {
  if (!state.openNote) return toast('Open a note first.');
  try {
    await flushQuietly();
    const { filename, text } = io.noteToFile(await notes.get(state.openNote.id));
    downloadBlob(text, filename, 'text/markdown;charset=utf-8');
  } catch (err) {
    toastError(err);
  }
}

async function exportEverything() {
  try {
    await flushQuietly();
    downloadBlob(await io.exportZip(), `knowledge-base-${isoDay()}.zip`, 'application/zip');
  } catch (err) {
    toastError(err);
  }
}

async function exportBackup() {
  try {
    await flushQuietly();
    downloadBlob(JSON.stringify(await io.exportBackup(), null, 2), `knowledge-base-backup-${isoDay()}.json`, 'application/json');
  } catch (err) {
    toastError(err);
  }
}

async function restoreFromFile(file) {
  if (!file) return;
  try {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      throw new KbError('INVALID_BACKUP', 'Invalid backup file: it is not valid JSON.');
    }
    io.validateBackup(data); // fail early, before asking for confirmation
    const ok = await confirmDialog({
      title: 'Restore backup?',
      message: `This replaces ALL current notes and folders with the contents of “${file.name}” (${data.notes.length} notes, ${data.folders.length} folders). Export a backup first if you might need the current data.`,
      confirmLabel: 'Replace everything',
      danger: true,
    });
    if (!ok) return;
    autosaver.cancel(state.openNote?.id);
    await io.restoreBackup(data);
    closeEditor();
    state.expanded = new Set();
    persistExpanded();
    state.selected = { type: 'folder', id: null };
    await refresh();
    showFolderView(null);
    notifyChanged();
    toast('Backup restored.');
  } catch (err) {
    if (err instanceof KbError && err.code === 'INVALID_BACKUP') await alertDialog({ title: 'Restore failed', lines: [err.message, 'Your current data was not changed.'] });
    else toastError(err);
  }
}

// ---------------------------------------------------------------- chrome: theme, drawer, menu, toolbar

const THEMES = ['auto', 'light', 'dark'];

function applyTheme(theme) {
  state.theme = THEMES.includes(theme) ? theme : 'auto';
  document.documentElement.dataset.theme = state.theme;
  $('theme-label').textContent = `Theme: ${state.theme[0].toUpperCase()}${state.theme.slice(1)}`;
  requestAnimationFrame(() => {
    const color = getComputedStyle(document.body).getPropertyValue('--sidebar').trim();
    if (color) $('theme-color').setAttribute('content', color);
  });
}

function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(state.theme) + 1) % THEMES.length];
  store.set('kb.theme', next);
  applyTheme(next);
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme(state.theme));

function openDrawer() {
  document.body.classList.add('drawer-open');
  $('scrim').hidden = false;
  syncDrawer();
  $('search').focus({ preventScroll: true });
}
function closeDrawer() {
  document.body.classList.remove('drawer-open');
  $('scrim').hidden = true;
  syncDrawer();
}
function syncDrawer() {
  // On phones the closed drawer is off-screen: keep it out of the tab order and accessibility tree.
  $('sidebar').inert = mobileQuery.matches && !document.body.classList.contains('drawer-open');
}
mobileQuery.addEventListener?.('change', () => {
  if (!mobileQuery.matches) closeDrawer();
  syncDrawer();
});

function toggleMenu(open) {
  const menu = $('more-menu');
  menu.hidden = !open;
  $('btn-more').setAttribute('aria-expanded', String(open));
  if (open) {
    $('more-menu').querySelector('[data-action="export-note"]').disabled = !state.openNote;
    menu.querySelector('[role="menuitem"]:not(:disabled):not([hidden])')?.focus();
  }
}

function updateToolbar() {
  const rootSelected = state.selected.type === 'folder' && state.selected.id == null;
  for (const id of ['btn-rename', 'btn-move', 'btn-delete']) $(id).disabled = !state.ready || rootSelected;
}

async function handleMenuAction(action) {
  switch (action) {
    case 'import-md': return $('file-md').click();
    case 'import-zip': return $('file-zip').click();
    case 'export-note': return exportCurrentNote();
    case 'export-zip': return exportEverything();
    case 'backup': return exportBackup();
    case 'restore': return $('file-json').click();
    case 'theme': return cycleTheme();
    case 'install': {
      const prompt = state.installPrompt;
      state.installPrompt = null;
      $('more-menu').querySelector('[data-action="install"]').hidden = true;
      if (prompt) await prompt.prompt();
      return undefined;
    }
    case 'shortcuts':
      return alertDialog({
        title: 'Keyboard shortcuts',
        lines: [
          'Alt+N: new note in the current folder',
          'Ctrl/Cmd+K: search',
          'Ctrl/Cmd+S: save now',
          'Esc: close menu, drawer or clear search',
          'In the tree: arrow keys to move, Enter to open, F2 to rename, Delete to delete',
          'Drag a note or folder onto a folder to move it (or use Move).',
        ],
      });
    default:
      return undefined;
  }
}

function wireStaticEvents() {
  $('btn-new-note').addEventListener('click', newNote);
  $('btn-new-folder').addEventListener('click', newFolder);
  $('btn-rename').addEventListener('click', () => renameItem());
  $('btn-move').addEventListener('click', () => moveItem());
  $('btn-delete').addEventListener('click', () => deleteItem());
  $('btn-menu').addEventListener('click', openDrawer);
  $('btn-close-drawer').addEventListener('click', closeDrawer);
  $('scrim').addEventListener('click', closeDrawer);
  $('note-title').addEventListener('input', onTitleInput);
  $('note-content').addEventListener('input', onContentInput);
  $('search').addEventListener('input', onSearchInput);

  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('search').value) {
      clearSearch();
      e.stopPropagation();
    } else if (e.key === 'ArrowDown') {
      $('search-results').querySelector('.result')?.focus();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      $('search-results').querySelector('.result')?.click();
    }
  });
  $('search-results').addEventListener('keydown', (e) => {
    const items = [...$('search-results').querySelectorAll('.result')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') items[Math.min(items.length - 1, i + 1)]?.focus();
    else if (e.key === 'ArrowUp') (i <= 0 ? $('search') : items[i - 1]).focus();
    else return;
    e.preventDefault();
  });

  for (const b of $('view-toggle').querySelectorAll('button')) b.addEventListener('click', () => setView(b.dataset.view));

  $('btn-more').addEventListener('click', () => toggleMenu($('more-menu').hidden));
  $('more-menu').addEventListener('click', (e) => {
    const item = e.target.closest('[data-action]');
    if (!item || item.disabled) return;
    toggleMenu(false);
    handleMenuAction(item.dataset.action);
  });
  $('more-menu').addEventListener('keydown', (e) => {
    const items = [...$('more-menu').querySelectorAll('[role="menuitem"]:not(:disabled):not([hidden])')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') items[(i + 1) % items.length].focus();
    else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length].focus();
    else if (e.key === 'Escape') {
      toggleMenu(false);
      $('btn-more').focus();
    } else if (e.key === 'Tab') toggleMenu(false);
    else return;
    e.preventDefault();
  });
  document.addEventListener('click', (e) => {
    if (!$('more-menu').hidden && !e.target.closest('.menu-wrap')) toggleMenu(false);
  });

  $('file-md').addEventListener('change', (e) => {
    importMarkdown(e.target.files).finally(() => (e.target.value = ''));
  });
  $('file-zip').addEventListener('change', (e) => {
    importZipFile(e.target.files[0]).finally(() => (e.target.value = ''));
  });
  $('file-json').addEventListener('change', (e) => {
    restoreFromFile(e.target.files[0]).finally(() => (e.target.value = ''));
  });

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.altKey && !mod && !e.shiftKey && e.code === 'KeyN') {
      e.preventDefault();
      newNote();
    } else if (mod && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (mobileQuery.matches) openDrawer();
      $('search').focus();
      $('search').select();
    } else if (mod && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (autosaver) flushQuietly().then(() => state.openNote && toast('Saved.'));
    } else if (e.key === 'Escape' && document.body.classList.contains('drawer-open') && !document.querySelector('dialog[open]')) {
      closeDrawer();
    }
  });

  window.addEventListener('pagehide', () => autosaver?.flush().catch(() => {}));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') autosaver?.flush().catch(() => {});
  });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installPrompt = e;
    $('more-menu').querySelector('[data-action="install"]').hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    state.installPrompt = null;
    $('more-menu').querySelector('[data-action="install"]').hidden = true;
  });

  syncDrawer();
}

init();
