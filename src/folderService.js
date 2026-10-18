import { KbError } from './errors.js';

export const MAX_NAME_LENGTH = 200;
export const ROOT_NAME = 'Knowledge Base';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const byName = (a, b) => collator.compare(a.name, b.name);

/** Validates and trims a folder name. Throws KbError('INVALID_NAME'). */
export function validateName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) throw new KbError('INVALID_NAME', 'Please enter a name.');
  if (name.length > MAX_NAME_LENGTH) throw new KbError('INVALID_NAME', `Names can be at most ${MAX_NAME_LENGTH} characters.`);
  if (/[/\\]/.test(name)) throw new KbError('INVALID_NAME', 'Folder names cannot contain / or \\.');
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new KbError('INVALID_NAME', 'Folder names cannot contain control characters.');
  if (name === '.' || name === '..') throw new KbError('INVALID_NAME', 'That folder name is not allowed.');
  return name;
}

/** Pure helper: Map(folderId -> [ancestor names..., own name]) for a list of folders. */
export function buildPathMap(folders) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const cache = new Map();
  const resolve = (id) => {
    if (cache.has(id)) return cache.get(id);
    const parts = [];
    const seen = new Set();
    let cur = byId.get(id);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      parts.unshift(cur.name);
      cur = cur.parentId == null ? null : byId.get(cur.parentId);
    }
    cache.set(id, parts);
    return parts;
  };
  const map = new Map();
  for (const f of folders) map.set(f.id, resolve(f.id));
  return map;
}

export function createFolderService(db) {
  const now = () => Date.now();

  async function get(id) {
    const folder = await db.folders.get(id);
    if (!folder) throw new KbError('NOT_FOUND', 'That folder no longer exists.');
    return folder;
  }

  async function assertParent(parentId) {
    if (parentId == null) return;
    if (!(await db.folders.get(parentId))) throw new KbError('NOT_FOUND', 'The destination folder no longer exists.');
  }

  function childrenOf(parentId) {
    return parentId == null
      ? db.folders.filter((f) => f.parentId == null).toArray()
      : db.folders.where('parentId').equals(parentId).toArray();
  }

  async function findChild(parentId, name) {
    const lower = name.toLowerCase();
    return (await childrenOf(parentId)).find((f) => f.name.toLowerCase() === lower) || null;
  }

  async function assertNameFree(parentId, name, exceptId) {
    const clash = await findChild(parentId, name);
    if (clash && clash.id !== exceptId) {
      throw new KbError('DUPLICATE', `A folder named “${name}” already exists here.`);
    }
  }

  async function create(name, parentId = null) {
    const clean = validateName(name);
    return db.transaction('rw', db.folders, async () => {
      await assertParent(parentId);
      await assertNameFree(parentId, clean);
      const t = now();
      const id = await db.folders.add({ name: clean, parentId, createdAt: t, updatedAt: t });
      return db.folders.get(id);
    });
  }

  async function rename(id, name) {
    const clean = validateName(name);
    return db.transaction('rw', db.folders, async () => {
      const folder = await get(id);
      if (folder.name === clean) return folder;
      await assertNameFree(folder.parentId ?? null, clean, id);
      await db.folders.update(id, { name: clean, updatedAt: now() });
      return db.folders.get(id);
    });
  }

  /** Moves a folder under newParentId (null = root). Rejects cycles and name clashes. */
  async function move(id, newParentId = null) {
    return db.transaction('rw', db.folders, async () => {
      const folder = await get(id);
      await assertParent(newParentId);
      const cycle = new KbError('CYCLE', 'A folder cannot be moved into itself or one of its subfolders.');
      let cur = newParentId;
      const seen = new Set();
      while (cur != null) {
        if (cur === id) throw cycle;
        if (seen.has(cur)) break;
        seen.add(cur);
        cur = (await db.folders.get(cur))?.parentId ?? null;
      }
      if ((folder.parentId ?? null) === newParentId) return folder;
      await assertNameFree(newParentId, folder.name, id);
      await db.folders.update(id, { parentId: newParentId, updatedAt: now() });
      return db.folders.get(id);
    });
  }

  async function descendantIds(id) {
    const all = await db.folders.toArray();
    const kids = new Map();
    for (const f of all) {
      const key = f.parentId ?? null;
      if (!kids.has(key)) kids.set(key, []);
      kids.get(key).push(f.id);
    }
    const out = [];
    const stack = [...(kids.get(id) || [])];
    while (stack.length) {
      const cur = stack.pop();
      out.push(cur);
      stack.push(...(kids.get(cur) || []));
    }
    return out;
  }

  /** Counts what a delete would remove: { folders, notes } (excluding the folder itself). */
  async function countContents(id) {
    const ids = [id, ...(await descendantIds(id))];
    const notes = await db.notes.where('folderId').anyOf(ids).count();
    return { folders: ids.length - 1, notes };
  }

  /**
   * Deletion policy: a folder with subfolders or notes is only deleted when the
   * caller passes { recursive: true } (the UI asks for confirmation first).
   */
  async function remove(id, { recursive = false } = {}) {
    return db.transaction('rw', db.folders, db.notes, async () => {
      await get(id);
      const ids = [id, ...(await descendantIds(id))];
      const noteCount = await db.notes.where('folderId').anyOf(ids).count();
      if (!recursive && (ids.length > 1 || noteCount > 0)) {
        throw new KbError('NOT_EMPTY', 'This folder is not empty.', { folders: ids.length - 1, notes: noteCount });
      }
      await db.notes.where('folderId').anyOf(ids).delete();
      await db.folders.bulkDelete(ids);
      return { folders: ids.length, notes: noteCount };
    });
  }

  /** Finds or creates a chain of folders below parentId. Returns the deepest folder id. */
  async function ensurePath(names, parentId = null) {
    let parent = parentId;
    for (const raw of names) {
      const name = validateName(raw);
      const existing = await findChild(parent, name);
      parent = existing ? existing.id : (await create(name, parent)).id;
    }
    return parent;
  }

  async function list() {
    return db.folders.toArray();
  }

  async function getPath(id) {
    if (id == null) return [];
    const map = buildPathMap(await db.folders.toArray());
    return map.get(id) || [];
  }

  /** Nested structure for the sidebar. Root is virtual: { id: null, name: 'Knowledge Base' }. */
  async function getTree() {
    const [folders, notes] = await Promise.all([db.folders.toArray(), db.notes.toArray()]);
    const nodes = new Map(folders.map((f) => [f.id, { ...f, children: [], notes: [] }]));
    const root = { id: null, name: ROOT_NAME, parentId: null, children: [], notes: [] };
    for (const f of nodes.values()) {
      const parent = f.parentId != null ? nodes.get(f.parentId) : null;
      (parent || root).children.push(f);
    }
    for (const n of notes) {
      const summary = { id: n.id, title: n.title, folderId: n.folderId ?? null, updatedAt: n.updatedAt };
      const parent = n.folderId != null ? nodes.get(n.folderId) : null;
      (parent || root).notes.push(summary);
    }
    const titleSort = (a, b) => collator.compare(a.title, b.title);
    for (const node of [root, ...nodes.values()]) {
      node.children.sort(byName);
      node.notes.sort(titleSort);
    }
    return root;
  }

  return { get, create, rename, move, remove, countContents, ensurePath, findChild, list, getPath, getTree, descendantIds };
}
