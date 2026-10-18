import { KbError } from './errors.js';

export const DEFAULT_TITLE = 'Untitled Note';
export const MAX_TITLE_LENGTH = 200;

/** Titles are never rejected (the user may clear the field while typing); empty becomes the default. */
export function normalizeTitle(raw) {
  const title = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TITLE_LENGTH).trim();
  return title || DEFAULT_TITLE;
}

export function createNoteService(db) {
  const now = () => Date.now();

  async function assertFolder(folderId) {
    if (folderId != null && !(await db.folders.get(folderId))) {
      throw new KbError('NOT_FOUND', 'The destination folder no longer exists.');
    }
  }

  function inFolder(folderId) {
    return folderId == null
      ? db.notes.filter((n) => n.folderId == null)
      : db.notes.where('folderId').equals(folderId);
  }

  async function nextUntitled(folderId) {
    const titles = new Set((await inFolder(folderId).toArray()).map((n) => n.title.toLowerCase()));
    if (!titles.has(DEFAULT_TITLE.toLowerCase())) return DEFAULT_TITLE;
    let i = 2;
    while (titles.has(`${DEFAULT_TITLE} ${i}`.toLowerCase())) i++;
    return `${DEFAULT_TITLE} ${i}`;
  }

  async function create({ folderId = null, title, content = '' } = {}) {
    return db.transaction('rw', db.notes, db.folders, async () => {
      await assertFolder(folderId);
      const finalTitle = title == null ? await nextUntitled(folderId) : normalizeTitle(title);
      const t = now();
      const id = await db.notes.add({ title: finalTitle, folderId, content: String(content), createdAt: t, updatedAt: t });
      return db.notes.get(id);
    });
  }

  async function get(id) {
    const note = await db.notes.get(id);
    if (!note) throw new KbError('NOT_FOUND', 'That note no longer exists.');
    return note;
  }

  /** Updates title and/or content. A no-op (nothing changed) leaves updatedAt untouched. */
  async function update(id, patch) {
    return db.transaction('rw', db.notes, async () => {
      const note = await get(id);
      const changes = {};
      if (patch.title !== undefined) {
        const title = normalizeTitle(patch.title);
        if (title !== note.title) changes.title = title;
      }
      if (patch.content !== undefined && String(patch.content) !== note.content) {
        changes.content = String(patch.content);
      }
      if (!Object.keys(changes).length) return note;
      changes.updatedAt = now();
      await db.notes.update(id, changes);
      return db.notes.get(id);
    });
  }

  const rename = (id, title) => update(id, { title });

  async function move(id, folderId = null) {
    return db.transaction('rw', db.notes, db.folders, async () => {
      const note = await get(id);
      await assertFolder(folderId);
      if ((note.folderId ?? null) === folderId) return note;
      await db.notes.update(id, { folderId, updatedAt: now() });
      return db.notes.get(id);
    });
  }

  async function remove(id) {
    await get(id);
    await db.notes.delete(id);
  }

  /** Notes of one folder (without loading content into the result). */
  async function listByFolder(folderId = null) {
    const rows = await inFolder(folderId).toArray();
    return rows
      .map((n) => ({ id: n.id, title: n.title, folderId: n.folderId ?? null, updatedAt: n.updatedAt, size: n.content.length }))
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }));
  }

  return { create, get, update, rename, move, remove, listByFolder };
}

/**
 * Debounced autosave. Edits are merged per note and written after `delay` ms of quiet.
 * onStatus receives { state: 'dirty' | 'saving' | 'saved' | 'error', note?, error? }.
 * Failed writes stay queued and are retried, so no keystrokes are lost to a transient error.
 */
export function createAutosaver(noteService, { delay = 600, retryDelay = 4000, onStatus = () => {} } = {}) {
  const pending = new Map();
  let timer = null;
  let chain = Promise.resolve();

  function arm(ms) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      flush().catch(() => {});
    }, ms);
  }

  function schedule(id, patch) {
    pending.set(id, { ...(pending.get(id) || {}), ...patch });
    onStatus({ state: 'dirty' });
    arm(delay);
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    const batch = [...pending];
    pending.clear();
    if (!batch.length) return chain.catch(() => {});

    onStatus({ state: 'saving' });
    const run = chain.catch(() => {}).then(async () => {
      try {
        let last = null;
        for (const [id, patch] of batch) {
          try {
            last = await noteService.update(id, patch);
          } catch (err) {
            if (err && err.code === 'NOT_FOUND') continue; // note was deleted meanwhile
            throw err;
          }
        }
        onStatus({ state: pending.size ? 'dirty' : 'saved', note: last });
      } catch (err) {
        for (const [id, patch] of batch) pending.set(id, { ...patch, ...(pending.get(id) || {}) });
        onStatus({ state: 'error', error: err });
        arm(retryDelay);
        throw err;
      }
    });
    chain = run;
    return run;
  }

  return {
    schedule,
    flush,
    hasPending: () => pending.size > 0,
    cancel(id) {
      pending.delete(id);
      if (!pending.size) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
