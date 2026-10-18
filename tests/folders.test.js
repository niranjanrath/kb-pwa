import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, rejectsWithCode } from './helpers.js';

test('creates nested folders and builds a data-driven tree', async () => {
  const { folders, notes } = setup();
  const eng = await folders.create('Engineering');
  const java = await folders.create('Java', eng.id);
  await folders.create('DevOps', eng.id);
  await notes.create({ folderId: java.id, title: 'Spring Boot' });
  await notes.create({ title: 'Root note' });

  const tree = await folders.getTree();
  assert.equal(tree.id, null);
  assert.deepEqual(tree.children.map((f) => f.name), ['Engineering']);
  assert.deepEqual(tree.children[0].children.map((f) => f.name), ['DevOps', 'Java']);
  assert.deepEqual(tree.children[0].children[1].notes.map((n) => n.title), ['Spring Boot']);
  assert.deepEqual(tree.notes.map((n) => n.title), ['Root note']);
  assert.deepEqual(await folders.getPath(java.id), ['Engineering', 'Java']);
});

test('validates names and rejects duplicate siblings (case-insensitive)', async () => {
  const { folders } = setup();
  await folders.create('AI');
  await rejectsWithCode(assert, folders.create('ai'), 'DUPLICATE');
  await rejectsWithCode(assert, folders.create('   '), 'INVALID_NAME');
  await rejectsWithCode(assert, folders.create('a/b'), 'INVALID_NAME');
  await rejectsWithCode(assert, folders.create('..'), 'INVALID_NAME');
  await rejectsWithCode(assert, folders.create('x', 9999), 'NOT_FOUND');
  // same name under a different parent is fine
  const a = await folders.create('A');
  await folders.create('AI', a.id);
});

test('rename keeps note references intact (stable ids)', async () => {
  const { folders, notes } = setup();
  const f = await folders.create('Old');
  const n = await notes.create({ folderId: f.id, title: 'N' });
  await folders.rename(f.id, 'New');
  assert.equal((await notes.get(n.id)).folderId, f.id);
  assert.deepEqual(await folders.getPath(f.id), ['New']);
  await rejectsWithCode(assert, folders.rename(12345, 'x'), 'NOT_FOUND');
});

test('move prevents cycles and name clashes, and allows moving to root', async () => {
  const { folders } = setup();
  const a = await folders.create('A');
  const b = await folders.create('B', a.id);
  const c = await folders.create('C', b.id);

  await rejectsWithCode(assert, folders.move(a.id, a.id), 'CYCLE');
  await rejectsWithCode(assert, folders.move(a.id, c.id), 'CYCLE');

  await folders.create('B'); // root-level "B"
  await rejectsWithCode(assert, folders.move(b.id, null), 'DUPLICATE');

  const moved = await folders.move(c.id, null);
  assert.equal(moved.parentId, null);
  assert.deepEqual(await folders.getPath(c.id), ['C']);
});

test('delete policy: non-empty folders need recursive:true, which removes everything below', async () => {
  const { folders, notes, db } = setup();
  const a = await folders.create('A');
  const b = await folders.create('B', a.id);
  await notes.create({ folderId: b.id, title: 'deep' });
  await notes.create({ folderId: a.id, title: 'shallow' });
  const keep = await notes.create({ title: 'keep me' });

  await assert.rejects(folders.remove(a.id), (e) => {
    assert.equal(e.code, 'NOT_EMPTY');
    assert.deepEqual({ folders: e.details.folders, notes: e.details.notes }, { folders: 1, notes: 2 });
    return true;
  });
  assert.deepEqual(await folders.countContents(a.id), { folders: 1, notes: 2 });
  assert.equal(await db.folders.count(), 2);

  assert.deepEqual(await folders.remove(a.id, { recursive: true }), { folders: 2, notes: 2 });
  assert.equal(await db.folders.count(), 0);
  assert.deepEqual((await db.notes.toArray()).map((n) => n.id), [keep.id]);

  const empty = await folders.create('Empty');
  await folders.remove(empty.id); // empty folders delete without the flag
  assert.equal(await db.folders.count(), 0);
});

test('ensurePath finds or creates a chain', async () => {
  const { folders } = setup();
  const id1 = await folders.ensurePath(['X', 'Y', 'Z']);
  const id2 = await folders.ensurePath(['x', 'y', 'z']);
  assert.equal(id1, id2);
  assert.equal((await folders.list()).length, 3);
});
