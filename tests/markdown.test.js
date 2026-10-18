import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let render;
let doc;

before(async () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  doc = dom.window.document;
  const { renderMarkdownInto } = await import('../src/markdown.js');
  render = (md) => {
    const el = doc.createElement('div');
    renderMarkdownInto(el, md);
    return el;
  };
});

test('renders common Markdown: headings, lists, checklists, links, quotes, tables, code', () => {
  const el = render(
    '# Title\n\n- a\n- b\n\n- [x] done\n- [ ] todo\n\n> quote\n\n| h1 | h2 |\n|----|----|\n| c1 | c2 |\n\n`inline`\n\n[site](https://example.com)\n',
  );
  assert.equal(el.querySelector('h1').textContent, 'Title');
  assert.equal(el.querySelectorAll('li').length, 4);
  const boxes = [...el.querySelectorAll('input[type=checkbox]')];
  assert.deepEqual(boxes.map((b) => b.checked), [true, false]);
  assert.ok(boxes.every((b) => b.disabled));
  assert.ok(el.querySelector('blockquote'));
  assert.equal(el.querySelectorAll('table th').length, 2);
  assert.equal(el.querySelector('p code').textContent, 'inline');
  const a = el.querySelector('a');
  assert.equal(a.getAttribute('target'), '_blank');
  assert.match(a.getAttribute('rel'), /noopener/);
});

test('fenced code is syntax highlighted for known languages and escaped otherwise', () => {
  const el = render('```js\nconst x = "<b>";\n```\n\n```nonsense\n<script>alert(1)</script>\n```\n');
  const [js, other] = el.querySelectorAll('pre code');
  assert.ok(js.querySelector('.hljs-keyword'), 'keyword span present');
  assert.equal(js.textContent.trim(), 'const x = "<b>";');
  assert.equal(other.textContent.trim(), '<script>alert(1)</script>');
  assert.equal(el.querySelector('script'), null);
});

test('XSS payloads are neutralised', () => {
  const payloads = [
    '<script>window.pwned=1</script>',
    '<img src=x onerror="window.pwned=1">',
    '<a href="javascript:window.pwned=1">click</a>',
    '[x](javascript:alert(1))',
    '<svg onload="window.pwned=1"><circle/></svg>',
    '<iframe src="https://evil.example"></iframe>',
    '<div style="background:url(https://evil.example/x)" onclick="window.pwned=1">hi</div>',
    '<form action="https://evil.example"><input name=q><button>go</button></form>',
    '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
    '<details open ontoggle="window.pwned=1">x</details>',
    '<input type="text" value="phish">',
    '<style>body{display:none}</style>',
  ];
  for (const p of payloads) {
    const el = render(p);
    const html = el.innerHTML.toLowerCase();
    assert.ok(!/<script|<iframe|<svg|<form|<style|<math|<button|onerror|onload|onclick|ontoggle|javascript:|style=|type="text"/.test(html), `unsafe output for ${p}: ${html}`);
  }
  assert.equal(window.pwned, undefined);
});

test('remote images are not loaded and are replaced by a link; data images are kept', () => {
  const el = render('![logo](https://tracker.example/pixel.png)\n\n![ok](data:image/png;base64,iVBORw0KGgo=)\n\n<img src="//evil.example/a.png">');
  const imgs = [...el.querySelectorAll('img')];
  assert.equal(imgs.length, 1);
  assert.match(imgs[0].getAttribute('src'), /^data:image\/png/);
  const link = el.querySelector('a[href="https://tracker.example/pixel.png"]');
  assert.ok(link);
  assert.match(link.textContent, /logo/);
});

test('relative links lose their href; class and id attributes cannot be injected', () => {
  const el = render('[rel](notes/other.md) [frag](#top)\n\n<div class="toolbar" id="tree">x</div>\n\n<span class="hljs-keyword evil">y</span>');
  assert.ok([...el.querySelectorAll('a')].every((a) => !a.hasAttribute('href')));
  const div = [...el.querySelectorAll('div')][0];
  assert.ok(!div.hasAttribute('class') && !div.hasAttribute('id'));
  assert.ok(!el.querySelector('span[class]'), 'non-highlight classes are rejected');
});
