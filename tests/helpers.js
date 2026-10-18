import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { createDatabase } from '../src/db.js';
import { createFolderService } from '../src/folderService.js';
import { createNoteService } from '../src/noteService.js';
import { createSearchService } from '../src/searchService.js';
import { createImportExport } from '../src/importExport.js';

let counter = 0;

/** A fresh, isolated in-memory database with all services wired up. */
export function setup() {
  const db = createDatabase(`test-db-${++counter}-${Math.random().toString(36).slice(2)}`, { indexedDB, IDBKeyRange });
  const folders = createFolderService(db);
  const notes = createNoteService(db);
  const search = createSearchService(db);
  const io = createImportExport({ db, folderService: folders });
  return { db, folders, notes, search, io };
}

/** Asserts that a promise rejects with a KbError carrying the given code. */
export async function rejectsWithCode(assert, promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}: ${err.message}`);
    return true;
  });
}
