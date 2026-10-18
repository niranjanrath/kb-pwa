import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from '../vendor/jszip.mjs';
import { setup, rejectsWithCode } from './helpers.js';
import { sanitizeFileName, safeSegments } from '../src/importExport.js';

async function populated() {
  const ctx = setup();
  const arch = await ctx.folders.create('Architecture');
  const dp = await ctx.folders.create('Design Patterns', arch.id);
  await ctx.folders.create('Empty Folder');
  await ctx.notes.create({ title: 'Root Note', content: 'root\r\nwith CRLF and ünïcode ✓\n' });
  await ctx.notes.create({ folderId: arch.id, title: 'C4 Model', content: '# C4\n' });
  await ctx.notes.create({ folderId: dp.id, title: 'CQRS', content: '```js\nconst a = 1;\n```\n' });
  return ctx;
}

const snapshot = async (db, folders) => {
  const paths = new Map((await db.folders.toArray()).map((f) => [f.id, f.name]));
  const all = await db.folders.toArray();
  const full = (f) => (f.parentId ? `${full(all.find((x) => x.id === f.parentId))}/${f.name}` : f.name);
  return {
    folders: all.map(full).sort(),
    notes: (await db.notes.toArray())
      .map((n) => `${n.folderId ? full(all.find((x) => x.id === n.folderId)) : ''}|${n.title}|${n.content}`)
      .sort(),
    unused: paths.size,
  };
};

test('exports a ZIP whose paths mirror the folder hierarchy', async () => {
  const { io } = await populated();
  const zip = await JSZip.loadAsync(await io.exportZip());
  const names = Object.keys(zip.files).sort();
  assert.deepEqual(names, [
    'Architecture/',
    'Architecture/C4 Model.md',
    'Architecture/Design Patterns/',
    'Architecture/Design Patterns/CQRS.md',
    'Empty Folder/',
    'Root Note.md',
  ]);
  assert.equal(await zip.file('Root Note.md').async('string'), 'root\r\nwith CRLF and ünïcode ✓\n');
});

test('ZIP round trip into a fresh database preserves folders, notes and content exactly', async () => {
  const a = await populated();
  const bytes = await a.io.exportZip();

  const b = setup();
  const report = await b.io.importZip(bytes);
  assert.equal(report.notesCreated, 3);
  assert.equal(report.foldersCreated, 3);
  assert.deepEqual(await snapshot(b.db), await snapshot(a.db));
});

test('importing the same ZIP twice is idempotent; changed notes are kept with a suffix', async () => {
  const a = await populated();
  const bytes = await a.io.exportZip();
  const b = setup();
  await b.io.importZip(bytes);
  const again = await b.io.importZip(bytes);
  assert.equal(again.notesCreated, 0);
  assert.equal(again.notesSkipped, 3);
  assert.equal(again.foldersCreated, 0);

  const n = (await b.db.notes.toArray()).find((x) => x.title === 'C4 Model');
  await b.notes.update(n.id, { content: 'edited locally' });
  const third = await b.io.importZip(bytes);
  assert.equal(third.notesCreated, 1);
  assert.deepEqual(
    (await b.db.notes.toArray()).map((x) => x.title).filter((t) => t.startsWith('C4')).sort(),
    ['C4 Model', 'C4 Model (2)'],
  );
});

test('duplicate titles and unsafe names export to unique, safe file names', async () => {
  const { io, notes } = setup();
  await notes.create({ title: 'Same', content: '1' });
  await notes.create({ title: 'same', content: '2' });
  await notes.create({ title: 'a/b: c?', content: '3' });
  await notes.create({ title: 'CON', content: '4' });
  const zip = await JSZip.loadAsync(await io.exportZip());
  // "Same" and "same" collide case-insensitively, so exactly one gets the " (2)" suffix
  assert.deepEqual(
    Object.keys(zip.files).map((n) => n.toLowerCase()).sort(),
    ['_con.md', 'a-b- c-.md', 'same (2).md', 'same.md'],
  );
  assert.equal(sanitizeFileName('  ..hidden. '), 'hidden');
  assert.equal(sanitizeFileName(''), 'Untitled');
});

test('imports to a chosen target folder and merges with existing folders', async () => {
  const { io, folders, notes, db } = setup();
  const target = await folders.create('Inbox');
  await folders.create('Docs', target.id);
  const zip = new JSZip();
  zip.file('Docs/Guide.md', '# Guide');
  zip.file('top.md', 'top');
  const report = await io.importZip(await zip.generateAsync({ type: 'uint8array' }), { targetFolderId: target.id });
  assert.equal(report.foldersCreated, 0, 'existing "Docs" is reused');
  const all = await db.notes.toArray();
  assert.equal(all.length, 2);
  assert.ok(all.every((n) => n.folderId != null));
  assert.equal(notes !== undefined, true);
});

test('rejects invalid, empty and hostile archives safely', async () => {
  const { io, db } = setup();
  await rejectsWithCode(assert, io.importZip(new TextEncoder().encode('definitely not a zip')), 'INVALID_ARCHIVE');

  const empty = new JSZip();
  empty.file('readme.txt', 'no markdown here');
  await rejectsWithCode(assert, io.importZip(await empty.generateAsync({ type: 'uint8array' })), 'EMPTY_ARCHIVE');

  const evil = new JSZip();
  evil.file('../../escape.md', 'x');
  evil.file('/abs.md', 'x');
  evil.file('C:/win.md', 'x');
  evil.file('.hidden/secret.md', 'x');
  evil.file('__MACOSX/._junk.md', 'x');
  evil.file('ok.md', 'fine');
  evil.file('image.png', 'not markdown');
  const report = await io.importZip(await evil.generateAsync({ type: 'uint8array' }));
  // JSZip already flattens "../../escape.md" to "escape.md" when the archive is built;
  // absolute and drive-letter paths, dotfiles and __MACOSX are skipped by the importer.
  assert.deepEqual((await db.notes.toArray()).map((n) => n.title).sort(), ['escape', 'ok']);
  assert.ok(report.ignored.some((m) => m.startsWith('/abs.md')));
  assert.ok(report.ignored.some((m) => m.startsWith('C:/win.md')));
  assert.ok(report.ignored.some((m) => m.startsWith('image.png')));
  assert.equal((await db.folders.toArray()).length, 0, 'no folders created from unsafe paths');
});

test('safeSegments classifies entry names', () => {
  assert.deepEqual(safeSegments('a\\b/c.md').segs, ['a', 'b', 'c.md']);
  assert.ok(safeSegments('a/../b').unsafe);
  assert.ok(safeSegments('/etc/x').unsafe);
  assert.ok(safeSegments('.git/config').hidden);
});

test('imports individual .md files, strips BOM, keeps content byte-for-byte, dedupes titles', async () => {
  const { io, db } = setup();
  const text = '# Title\r\n\r\n- a\n- b\n\ttabbed\n';
  const r1 = await io.importMarkdownFiles([{ name: 'My Note.md', text: '\uFEFF' + text }]);
  assert.equal(r1.notesCreated, 1);
  const note = (await db.notes.toArray())[0];
  assert.equal(note.title, 'My Note');
  assert.equal(note.content, text);

  const r2 = await io.importMarkdownFiles([{ name: 'My Note.md', text: 'different' }]);
  assert.equal(r2.renamed, 1);
  assert.deepEqual((await db.notes.toArray()).map((n) => n.title).sort(), ['My Note', 'My Note (2)']);

  // exporting a note reproduces the same text
  assert.deepEqual(io.noteToFile(note), { filename: 'My Note.md', text });
});

test('JSON backup round trip restores ids, hierarchy and content (replace mode)', async () => {
  const a = await populated();
  const backup = JSON.parse(JSON.stringify(await a.io.exportBackup()));
  assert.equal(backup.format, 'local-markdown-kb-backup');

  const b = setup();
  await b.notes.create({ title: 'will be replaced' });
  const counts = await b.io.restoreBackup(backup);
  assert.deepEqual(counts, { folders: 3, notes: 3 });
  assert.deepEqual(await b.db.folders.toArray(), await a.db.folders.toArray());
  assert.deepEqual(await b.db.notes.toArray(), await a.db.notes.toArray());

  // auto-increment continues after the restored ids
  const fresh = await b.notes.create({ title: 'new' });
  assert.ok(fresh.id > Math.max(...backup.notes.map((n) => n.id)));
});

test('invalid backups are rejected before the database is modified', async () => {
  const { io, notes, db } = setup();
  await notes.create({ title: 'precious' });
  const good = await io.exportBackup();
  const cases = [
    null,
    { format: 'nope', version: 1, folders: [], notes: [] },
    { ...good, version: 99 },
    { ...good, folders: 'x' },
    { ...good, folders: [{ id: 1, name: 'A', parentId: 2 }, { id: 2, name: 'B', parentId: 1 }] },
    { ...good, folders: [{ id: 1, name: 'A', parentId: 7 }] },
    { ...good, folders: [{ id: 1, name: 'A' }, { id: 1, name: 'B' }] },
    { ...good, folders: [{ id: 1, name: 'A' }, { id: 2, name: 'a' }] },
    { ...good, notes: [{ id: 1, title: 'x', content: 5 }] },
    { ...good, notes: [{ id: 1, title: 'x', content: '', folderId: 42 }] },
  ];
  for (const bad of cases) await rejectsWithCode(assert, io.restoreBackup(bad), 'INVALID_BACKUP');
  assert.deepEqual((await db.notes.toArray()).map((n) => n.title), ['precious']);
});
