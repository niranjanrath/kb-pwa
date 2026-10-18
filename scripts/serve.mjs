// Tiny zero-dependency static file server for local use: `npm start` -> http://localhost:8080
// (Service workers and installability need http://localhost or https, not file://.)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.PORT) || 8080;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};
const allowed = ['index.html', 'styles.css', 'manifest.webmanifest', 'service-worker.js', 'src', 'vendor', 'icons'];

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let rel = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
    if (rel === '') rel = 'index.html';
    const top = rel.split(sep)[0];
    if (!allowed.includes(top)) throw Object.assign(new Error('not found'), { code: 404 });
    let file = join(root, rel);
    if (!file.startsWith(root + sep)) throw Object.assign(new Error('forbidden'), { code: 403 });
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': types[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      // Service workers may control the whole app, which lives at the site root here.
      'Service-Worker-Allowed': '/',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(err.code === 403 ? 403 : 404, { 'Content-Type': 'text/plain' });
    res.end(err.code === 403 ? 'Forbidden' : 'Not found');
  }
}).listen(port, () => console.log(`Knowledge Base running at http://localhost:${port}`));
