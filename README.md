# Knowledge Base — local-first Markdown PWA

A private, installable Markdown knowledge base. Notes live in your browser's IndexedDB
(via Dexie.js). There is no backend, no account and no network traffic for your data;
a strict Content-Security-Policy (`connect-src 'self'`) enforces this.

Stack: HTML5, vanilla JavaScript (ES modules), CSS3, Dexie.js, marked, DOMPurify,
highlight.js (core + common languages), JSZip. **No framework and no build step to run the app.**

## Quick start

```bash
npm install        # only needed for tests / re-vendoring; vendor/ is already included
npm start          # http://localhost:8080  (PORT=9000 npm start to change)
```

Service workers and installability need `http://localhost` or HTTPS — opening `index.html`
via `file://` will not work. Any static host works (GitHub Pages, Netlify, nginx…): just serve the folder.

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Zero-dependency static server (`scripts/serve.mjs`) |
| `npm test` | Node's built-in test runner with `fake-indexeddb` and `jsdom` (34 tests) |
| `npm run check` | Tests + precache list/imports/manifest consistency (`scripts/check.mjs`) |
| `npm run vendor` | Rebuilds `vendor/*.mjs` from `node_modules` (esbuild) |
| `npm run icons` | Regenerates the PNG icons |

After changing any file that the service worker precaches, bump `VERSION` in
`service-worker.js` so installed clients update (`npm run check` verifies the list matches disk).

## Layout

```
index.html  styles.css  manifest.webmanifest  service-worker.js
src/
  db.js             Dexie schema (folders, notes) with versioned migrations
  folderService.js  folder CRUD, tree, move (cycle-safe), delete policy
  noteService.js    note CRUD + debounced Autosaver
  markdown.js       marked + highlight.js + DOMPurify (sanitised preview)
  searchService.js  local title/content/folder search with snippets
  importExport.js   .md and ZIP import/export, JSON backup/restore
  treeView.js ui.js app.js   rendering and UI coordination
  sample.js         optional example structure
vendor/             browser-ready ES modules of the dependencies
tests/              folders, notes, search, markdown, import/export
```

Data model: `folders {id, name, parentId, createdAt, updatedAt}` and
`notes {id, title, folderId, content, createdAt, updatedAt}`. Relationships use stable
numeric IDs, never names or paths, so renames and moves can't break references.

## Using it

- **New note** (button, or `Alt+N`) creates "Untitled Note" in the selected folder and focuses the editor.
- Edit / Split / Preview toggle; changes autosave after a short pause, with a status indicator
  and last-modified time. `Ctrl/Cmd+S` saves immediately.
- Folders: create, rename, expand/collapse, move, delete. Deleting a non-empty folder
  asks for confirmation and removes everything inside it. Drag and drop moves notes and folders;
  the **Move** button does the same without dragging.
- Search (`Ctrl/Cmd+K`) matches titles, content and folder names, shows folder path and a snippet,
  and selecting a result opens the note and reveals it in the tree.
- **More** menu: import `.md` files or a ZIP, export the current note, export everything as a ZIP
  (folder hierarchy preserved), JSON backup/restore, install, theme (auto/light/dark), shortcuts.

## Security and privacy

- Rendered Markdown is always passed through DOMPurify; scripts, event handlers and
  `javascript:` URLs are stripped, and remote images are not loaded (replaced by a link).
- ZIP imports reject path traversal, absolute paths and unreadable archives before touching the database;
  invalid JSON backups are rejected before any data is modified.
- Nothing is sent anywhere. Clearing site data deletes your notes — use the backup regularly.

## Known limitations

- Search is a simple in-memory scan (fine for thousands of notes, not designed for huge corpora).
- Syntax highlighting covers common languages only (JS/TS, Java, Python, Bash, JSON, XML/HTML, CSS, SQL, YAML, Markdown, Docker, Go and a few more); others render unhighlighted.
- Remote images in notes are deliberately not displayed (privacy); `data:` images are.
- Browsers may evict IndexedDB under storage pressure or when site data is cleared; no sync is provided by design.
- Importing a ZIP merges into existing folders; notes whose content differs from an existing note with the same name are kept with a numeric suffix.
- Tests run in Node (fake IndexedDB, jsdom); there are no automated real-browser tests.
