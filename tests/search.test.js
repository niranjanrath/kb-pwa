import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { tokenize, splitHighlight, makeSnippet } from '../src/searchService.js';

async function fixture() {
  const ctx = setup();
  const eng = await ctx.folders.create('Engineering');
  const java = await ctx.folders.create('Java', eng.id);
  const sec = await ctx.folders.create('Security');
  ctx.ids = {
    spring: (await ctx.notes.create({ folderId: java.id, title: 'Spring Boot', content: 'Auto-configuration and starters make setup fast.' })).id,
    oauth: (await ctx.notes.create({ folderId: sec.id, title: 'OAuth2', content: 'Authorization code flow with PKCE. Spring Security supports it.' })).id,
    threat: (await ctx.notes.create({ folderId: sec.id, title: 'Threat Modeling', content: 'STRIDE: spoofing, tampering, repudiation...' })).id,
    java: java.id,
  };
  return ctx;
}

test('finds notes by title, content and folder name; AND semantics across terms', async () => {
  const { search, ids } = await fixture();

  assert.deepEqual((await search.search('oauth2')).notes.map((n) => n.id), [ids.oauth]);
  assert.deepEqual((await search.search('stride')).notes.map((n) => n.id), [ids.threat]);
  assert.deepEqual((await search.search('java')).notes.map((n) => n.id), [ids.spring]); // via folder path
  assert.deepEqual((await search.search('security pkce')).notes.map((n) => n.id), [ids.oauth]);
  assert.deepEqual((await search.search('spring zzz')).notes, []);
  assert.deepEqual((await search.search('   ')).notes, []);
});

test('ranks title hits above content hits', async () => {
  const { search, ids } = await fixture();
  const res = await search.search('spring');
  assert.deepEqual(res.notes.map((n) => n.id), [ids.spring, ids.oauth]);
});

test('results carry title, folder path and a snippet around the match', async () => {
  const { search, ids } = await fixture();
  const [hit] = (await search.search('pkce')).notes;
  assert.equal(hit.title, 'OAuth2');
  assert.deepEqual(hit.path, ['Security']);
  assert.match(hit.snippet, /PKCE/i);
  assert.equal(hit.id, ids.oauth);
});

test('matches folder names', async () => {
  const { search, ids } = await fixture();
  const res = await search.search('java');
  assert.deepEqual(res.folders.map((f) => ({ id: f.id, path: f.path })), [{ id: ids.java, path: ['Engineering'] }]);
});

test('is case-insensitive and treats regex characters literally', async () => {
  const { search, notes } = await fixture().then(async (c) => {
    await c.notes.create({ title: 'Regex', content: 'cost is $5 (approx) [a-z]+' });
    return c;
  });
  assert.equal((await search.search('SPOOFING')).notes.length, 1);
  assert.equal((await search.search('(approx)')).notes.length, 1);
  assert.equal((await search.search('[a-z]+')).notes.length, 1);
  assert.equal(notes !== undefined, true);
});

test('helpers: tokenize, snippet and highlight segments', () => {
  assert.deepEqual(tokenize('  Foo  foo BAR '), ['foo', 'bar']);
  const text = 'x'.repeat(200) + ' needle ' + 'y'.repeat(200);
  const snip = makeSnippet(text, ['needle']);
  assert.ok(snip.startsWith('…') && snip.endsWith('…') && snip.includes('needle'));
  assert.ok(snip.length < 200);
  assert.deepEqual(splitHighlight('Hello World', ['world']), [
    { text: 'Hello ', match: false },
    { text: 'World', match: true },
  ]);
});
