// Sanity checks that don't need a browser: service-worker precache list vs files on disk,
// every module import resolves, manifest icons exist, index.html references exist.
import { readFile, readdir, access } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';

let failed = false;
const fail = (msg) => { failed = true; console.error(`✖ ${msg}`); };
const ok = (msg) => console.log(`✔ ${msg}`);
const exists = (p) => access(p).then(() => true, () => false);

// 1. precache list
const sw = await readFile('service-worker.js', 'utf8');
const listed = [...sw.match(/const SHELL = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((p) => p !== './');
for (const p of listed) if (!(await exists(p))) fail(`service worker lists missing file ${p}`);
const onDisk = [];
for (const dir of ['src', 'vendor', 'icons']) {
  for (const f of await readdir(dir)) if (!/\.(txt|md)$/.test(f)) onDisk.push(`${dir}/${f}`);
}
for (const p of onDisk) if (!listed.includes(p)) fail(`${p} is not in the service worker precache list`);
for (const p of ['index.html', 'styles.css', 'manifest.webmanifest']) if (!listed.includes(p)) fail(`${p} missing from precache`);
if (!failed) ok(`precache list matches disk (${listed.length} files)`);

// 2. relative imports resolve
for (const dir of ['src']) {
  for (const f of await readdir(dir)) {
    const text = await readFile(join(dir, f), 'utf8');
    for (const m of text.matchAll(/from\s+'(\.[^']+)'/g)) {
      if (!(await exists(resolve(dir, m[1])))) fail(`${dir}/${f} imports missing ${m[1]}`);
    }
  }
}
ok('module imports resolve');

// 3. manifest + html references
const manifest = JSON.parse(await readFile('manifest.webmanifest', 'utf8'));
for (const icon of manifest.icons) if (!(await exists(icon.src))) fail(`manifest icon missing: ${icon.src}`);
const html = await readFile('index.html', 'utf8');
for (const m of html.matchAll(/(?:href|src)="([^"#:]+)"/g)) if (!(await exists(m[1]))) fail(`index.html references missing ${m[1]}`);
if (!/script-src 'self'/.test(html)) fail('CSP script-src missing');
ok('manifest and index.html references exist');

process.exit(failed ? 1 : 0);
