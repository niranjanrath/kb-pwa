import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, rejectsWithCode } from './helpers.js';
import { createAutosaver } from '../src/noteService.js';
import { createNoteService } from '../src/noteService.js';
import { createDatabase } from '../src/db.js';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('creates notes with numbered default titles and persists content', async () => {
  const { notes, folders } = setup();
  const f = await folders.create('F');
  const a = await notes.create({ folderId: f.id });
  const b = await notes.create({ folderId: f.id });
  const c = await notes.create({ folderId: f.id });
  assert.deepEqual([a.title, b.title, c.title], ['Untitled Note', 'Untitled Note 2', 'Untitled Note 3']);

  await notes.update(a.id, { content: '# Hello\n\nWörld ✓' });
  const again = await notes.get(a.id);
  assert.equal(again.content, '# Hello\n\nWörld ✓');
  assert.ok(again.updatedAt >= again.createdAt);
  await rejectsWithCode(assert, notes.create({ folderId: 999 }), 'NOT_FOUND');
});

test('notes survive closing and reopening the database', async () => {
  const name = `reopen-${Math.random()}`;
  const opts = { indexedDB, IDBKeyRange };
  const db1 = createDatabase(name, opts);
  const n = await createNoteService(db1).create({ title: 'Persistent', content: 'still here' });
  db1.close();

  const db2 = createDatabase(name, opts);
  const back = await createNoteService(db2).get(n.id);
  assert.equal(back.title, 'Persistent');
  assert.equal(back.content, 'still here');
  db2.close();
});

test('update is a no-op when nothing changed; empty titles fall back to the default', async () => {
  const { notes } = setup();
  const n = await notes.create({ title: 'T', content: 'x' });
  await sleep(5);
  const same = await notes.update(n.id, { title: 'T', content: 'x' });
  assert.equal(same.updatedAt, n.updatedAt);
  const blank = await notes.rename(n.id, '   ');
  assert.equal(blank.title, 'Untitled Note');
});

test('rename does not touch content; move and delete work', async () => {
  const { notes, folders } = setup();
  const f = await folders.create('F');
  const n = await notes.create({ title: 'A', content: 'body' });
  await notes.rename(n.id, 'B');
  assert.equal((await notes.get(n.id)).content, 'body');
  await notes.move(n.id, f.id);
  assert.equal((await notes.get(n.id)).folderId, f.id);
  await rejectsWithCode(assert, notes.move(n.id, 777), 'NOT_FOUND');
  assert.deepEqual((await notes.listByFolder(f.id)).map((x) => x.title), ['B']);
  await notes.remove(n.id);
  await rejectsWithCode(assert, notes.get(n.id), 'NOT_FOUND');
});

test('autosaver debounces, merges edits and reports status', async () => {
  const { notes } = setup();
  const n = await notes.create({ title: 'Doc' });
  const states = [];
  const saver = createAutosaver(notes, { delay: 30, onStatus: (s) => states.push(s.state) });

  saver.schedule(n.id, { content: 'a' });
  saver.schedule(n.id, { content: 'ab' });
  saver.schedule(n.id, { title: 'Doc 2' });
  assert.equal((await notes.get(n.id)).content, '', 'nothing written before the debounce');
  await sleep(120);

  const saved = await notes.get(n.id);
  assert.equal(saved.content, 'ab');
  assert.equal(saved.title, 'Doc 2');
  assert.equal(states.at(-1), 'saved');
  assert.ok(states.includes('dirty') && states.includes('saving'));
  assert.equal(saver.hasPending(), false);
});

test('autosaver.flush writes immediately and ignores deleted notes', async () => {
  const { notes } = setup();
  const n = await notes.create({ title: 'Gone' });
  const saver = createAutosaver(notes, { delay: 10_000 });
  saver.schedule(n.id, { content: 'unsaved' });
  await saver.flush();
  assert.equal((await notes.get(n.id)).content, 'unsaved');

  saver.schedule(n.id, { content: 'later' });
  await notes.remove(n.id);
  await saver.flush(); // must not throw
});

test('autosaver keeps failed edits queued and retries', async () => {
  let failures = 1;
  const fake = {
    saved: [],
    async update(id, patch) {
      if (failures-- > 0) throw new Error('disk full');
      this.saved.push([id, patch]);
      return { id, ...patch };
    },
  };
  const states = [];
  const saver = createAutosaver(fake, { delay: 10, retryDelay: 20, onStatus: (s) => states.push(s.state) });
  saver.schedule(1, { content: 'keep me' });
  await sleep(150);
  assert.deepEqual(fake.saved, [[1, { content: 'keep me' }]]);
  assert.ok(states.includes('error'));
  assert.equal(states.at(-1), 'saved');
});
