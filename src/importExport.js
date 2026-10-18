import JSZip from '../vendor/jszip.mjs';
import { KbError } from './errors.js';
import { validateName, MAX_NAME_LENGTH } from './folderService.js';
import { normalizeTitle } from './noteService.js';

export const BACKUP_FORMAT = 'local-markdown-kb-backup';
export const BACKUP_VERSION = 1;

// Limits that keep a hostile or corrupt archive from exhausting memory.
export const LIMITS = {
  zipBytes: 100 * 1024 * 1024,
  entries: 10000,
  fileBytes: 10 * 1024 * 1024,
  totalChars: 150 * 1024 * 1024,
};

const MD_EXT = /\.(md|markdown)$/i;

/** Makes a string safe to use as a file or folder name on Windows, macOS and Linux. */
export function sanitizeFileName(name, fallback = 'Untitled') {
  let s = String(name ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  if (!s) s = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) s = `_${s}`;
  return s.slice(0, 120).trim() || fallback;
}

function uniqueName(base, ext, used) {
  let candidate = `${base}${ext}`;
  let i = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${base} (${i++})${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/** Splits a zip entry name into safe path segments, or returns null when it must be ignored. */
export function safeSegments(entryName) {
  const raw = String(entryName).replace(/\\/g, '/');
  if (raw.replace(/\//g, '') === '') return { hidden: true }; // bare "/" root entries
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return { unsafe: true };
  const segs = raw.split('/').filter((s) => s !== '' && s !== '.');
  if (segs.some((s) => s === '..')) return { unsafe: true };
  if (segs.some((s) => s.startsWith('.') || s === '__MACOSX')) return { hidden: true };
  return { segs };
}

export function createImportExport({ db, folderService }) {
  // ---------- single notes ----------

  function noteToFile(note) {
    return { filename: `${sanitizeFileName(note.title)}.md`, text: note.content };
  }

  // ---------- shared note insertion with duplicate handling ----------

  async function titlesIn(folderId) {
    const rows =
      folderId == null
        ? await db.notes.filter((n) => n.folderId == null).toArray()
        : await db.notes.where('folderId').equals(folderId).toArray();
    return rows;
  }

  /**
   * Adds a note unless an identical one (same title and content) already exists in the folder,
   * which makes re-importing the same archive idempotent. A same-title note with different
   * content is kept and the new one gets a " (2)", " (3)", ... suffix.
   */
  async function addNote(folderId, title, content, report) {
    const existing = await titlesIn(folderId);
    const lower = title.toLowerCase();
    if (existing.some((n) => n.title.toLowerCase() === lower && n.content === content)) {
      report.notesSkipped++;
      return null;
    }
    const taken = new Set(existing.map((n) => n.title.toLowerCase()));
    let finalTitle = title;
    let i = 2;
    while (taken.has(finalTitle.toLowerCase())) finalTitle = `${title} (${i++})`;
    const t = Date.now();
    const id = await db.notes.add({ title: finalTitle, folderId, content, createdAt: t, updatedAt: t });
    report.notesCreated++;
    if (finalTitle !== title) report.renamed++;
    return id;
  }

  const newReport = () => ({ foldersCreated: 0, notesCreated: 0, notesSkipped: 0, renamed: 0, ignored: [] });

  const titleFromFilename = (filename) => normalizeTitle(filename.replace(MD_EXT, '').replace(/\.txt$/i, ''));
  const stripBom = (text) => text.replace(/^﻿/, '');

  /** Imports plain text/Markdown files: [{ name, text }] into folderId (null = root). */
  async function importMarkdownFiles(files, folderId = null) {
    const report = newReport();
    await db.transaction('rw', db.folders, db.notes, async () => {
      if (folderId != null) await folderService.get(folderId);
      for (const file of files) {
        if (typeof file.text !== 'string') {
          report.ignored.push(`${file.name}: not readable as text`);
          continue;
        }
        await addNote(folderId, titleFromFilename(file.name), stripBom(file.text), report);
      }
    });
    return report;
  }

  // ---------- ZIP export ----------

  async function exportZip() {
    const [folders, notes] = await Promise.all([db.folders.toArray(), db.notes.toArray()]);
    const folderIds = new Set(folders.map((f) => f.id));
    const kids = new Map();
    const notesBy = new Map();
    const push = (map, key, value) => {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(value);
    };
    for (const f of folders) push(kids, f.parentId != null && folderIds.has(f.parentId) ? f.parentId : null, f);
    for (const n of notes) push(notesBy, n.folderId != null && folderIds.has(n.folderId) ? n.folderId : null, n);

    const zip = new JSZip();
    const walk = (parentId, dir) => {
      const used = new Set();
      const subfolders = (kids.get(parentId) || []).sort((a, b) => a.name.localeCompare(b.name));
      for (const f of subfolders) {
        const name = uniqueName(sanitizeFileName(f.name, 'Folder'), '', used);
        zip.folder(`${dir}${name}`); // explicit entry so empty folders survive a round trip
        walk(f.id, `${dir}${name}/`);
      }
      const inThis = (notesBy.get(parentId) || []).sort((a, b) => a.title.localeCompare(b.title));
      for (const n of inThis) {
        const filename = uniqueName(sanitizeFileName(n.title), '.md', used);
        zip.file(`${dir}${filename}`, n.content, { date: new Date(n.updatedAt) });
      }
    };
    walk(null, '');
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  }

  // ---------- ZIP import ----------

  /** data: Uint8Array | ArrayBuffer | Blob. Imports below targetFolderId (null = root), merging folders by name. */
  async function importZip(data, { targetFolderId = null } = {}) {
    const size = data.byteLength ?? data.size ?? 0;
    if (size > LIMITS.zipBytes) throw new KbError('TOO_LARGE', 'This archive is too large to import.');

    let zip;
    try {
      zip = await JSZip.loadAsync(data);
    } catch {
      throw new KbError('INVALID_ARCHIVE', 'This file is not a valid ZIP archive.');
    }

    const entries = Object.values(zip.files);
    if (entries.length > LIMITS.entries) throw new KbError('TOO_LARGE', 'This archive contains too many files.');

    const report = newReport();
    const files = [];
    const dirs = [];
    let totalChars = 0;

    for (const entry of entries) {
      const parsed = safeSegments(entry.name);
      if (parsed.unsafe) {
        report.ignored.push(`${entry.name}: unsafe path`);
        continue;
      }
      if (parsed.hidden || !parsed.segs.length) continue;
      if (entry.dir) {
        dirs.push(parsed.segs);
        continue;
      }
      const name = parsed.segs[parsed.segs.length - 1];
      if (!MD_EXT.test(name)) {
        report.ignored.push(`${entry.name}: not a Markdown file`);
        continue;
      }
      const declared = entry._data && entry._data.uncompressedSize;
      if (declared > LIMITS.fileBytes) {
        report.ignored.push(`${entry.name}: file too large`);
        continue;
      }
      const text = stripBom(await entry.async('string'));
      if (text.length > LIMITS.fileBytes) {
        report.ignored.push(`${entry.name}: file too large`);
        continue;
      }
      totalChars += text.length;
      if (totalChars > LIMITS.totalChars) throw new KbError('TOO_LARGE', 'This archive expands to too much data.');
      files.push({ segs: parsed.segs, text });
    }

    if (!files.length && !dirs.length) {
      throw new KbError('EMPTY_ARCHIVE', 'No Markdown files were found in this archive.');
    }

    const folderName = (seg) => sanitizeFileName(seg, 'Folder').slice(0, MAX_NAME_LENGTH);

    await db.transaction('rw', db.folders, db.notes, async () => {
      if (targetFolderId != null) await folderService.get(targetFolderId);
      const cache = new Map();
      const ensure = async (segs) => {
        let parent = targetFolderId;
        let key = '';
        for (const seg of segs) {
          const name = validateName(folderName(seg));
          key += `/${name.toLowerCase()}`;
          if (cache.has(key)) {
            parent = cache.get(key);
            continue;
          }
          let folder = await folderService.findChild(parent, name);
          if (!folder) {
            folder = await folderService.create(name, parent);
            report.foldersCreated++;
          }
          cache.set(key, folder.id);
          parent = folder.id;
        }
        return parent;
      };

      for (const segs of dirs) await ensure(segs);
      for (const { segs, text } of files) {
        const folderId = await ensure(segs.slice(0, -1));
        await addNote(folderId, titleFromFilename(segs[segs.length - 1]), text, report);
      }
    });
    return report;
  }

  // ---------- JSON backup / restore ----------

  async function exportBackup() {
    const [folders, notes] = await Promise.all([db.folders.toArray(), db.notes.toArray()]);
    return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), folders, notes };
  }

  /** Validates a parsed backup and returns clean copies of its records. Throws KbError('INVALID_BACKUP'). */
  function validateBackup(data) {
    const bad = (msg) => new KbError('INVALID_BACKUP', `Invalid backup file: ${msg}`);
    if (!data || typeof data !== 'object' || data.format !== BACKUP_FORMAT) throw bad('this is not a Knowledge Base backup.');
    if (typeof data.version !== 'number' || data.version > BACKUP_VERSION) throw bad('it was created by a newer version of the app.');
    if (!Array.isArray(data.folders) || !Array.isArray(data.notes)) throw bad('folders or notes are missing.');

    const isId = (v) => Number.isSafeInteger(v) && v > 0;
    const stamp = (v) => (Number.isFinite(v) ? v : Date.now());
    const ids = new Set();
    const folders = [];
    for (const f of data.folders) {
      if (!f || !isId(f.id) || ids.has(f.id)) throw bad('a folder has a missing or duplicate id.');
      ids.add(f.id);
      let name;
      try {
        name = validateName(f.name);
      } catch {
        throw bad(`folder ${f.id} has an invalid name.`);
      }
      folders.push({ id: f.id, name, parentId: f.parentId ?? null, createdAt: stamp(f.createdAt), updatedAt: stamp(f.updatedAt) });
    }
    const byId = new Map(folders.map((f) => [f.id, f]));
    const siblingNames = new Set();
    for (const f of folders) {
      if (f.parentId !== null && !byId.has(f.parentId)) throw bad(`folder “${f.name}” points to a missing parent.`);
      const key = `${f.parentId}|${f.name.toLowerCase()}`;
      if (siblingNames.has(key)) throw bad(`two folders named “${f.name}” share a parent.`);
      siblingNames.add(key);
    }
    for (const f of folders) {
      const seen = new Set();
      for (let cur = f; cur; cur = cur.parentId === null ? null : byId.get(cur.parentId)) {
        if (seen.has(cur.id)) throw bad('the folder hierarchy contains a cycle.');
        seen.add(cur.id);
      }
    }

    const noteIds = new Set();
    const notes = [];
    for (const n of data.notes) {
      if (!n || !isId(n.id) || noteIds.has(n.id)) throw bad('a note has a missing or duplicate id.');
      noteIds.add(n.id);
      if (typeof n.title !== 'string' || typeof n.content !== 'string') throw bad(`note ${n.id} has an invalid title or content.`);
      const folderId = n.folderId ?? null;
      if (folderId !== null && !byId.has(folderId)) throw bad(`note “${n.title}” points to a missing folder.`);
      notes.push({ id: n.id, title: n.title, folderId, content: n.content, createdAt: stamp(n.createdAt), updatedAt: stamp(n.updatedAt) });
    }
    return { folders, notes };
  }

  /** Replaces ALL data with the backup. Validation happens before anything is touched. */
  async function restoreBackup(data) {
    const { folders, notes } = validateBackup(data);
    await db.transaction('rw', db.folders, db.notes, async () => {
      await db.folders.clear();
      await db.notes.clear();
      await db.folders.bulkAdd(folders);
      await db.notes.bulkAdd(notes);
    });
    return { folders: folders.length, notes: notes.length };
  }

  return { noteToFile, importMarkdownFiles, exportZip, importZip, exportBackup, validateBackup, restoreBackup };
}
