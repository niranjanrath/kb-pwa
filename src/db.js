import Dexie from '../vendor/dexie.mjs';

export const DB_NAME = 'local-markdown-kb';

// Schema versioning: never edit a released version() block. To change the schema,
// add `db.version(2).stores({...}).upgrade(tx => ...)` below and keep version 1.
//
// Note: IndexedDB cannot index `null`, so root-level items (parentId/folderId === null)
// are simply absent from those indexes; services query roots with a filter.
export function createDatabase(name = DB_NAME, options = {}) {
  const db = new Dexie(name, options);
  db.version(1).stores({
    folders: '++id, parentId, name, updatedAt',
    notes: '++id, folderId, title, updatedAt, createdAt',
  });
  return db;
}
