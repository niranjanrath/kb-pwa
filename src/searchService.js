import { buildPathMap } from './folderService.js';

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Lower-cased, de-duplicated search terms. */
export function tokenize(query) {
  return [...new Set(String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean))];
}

/** Splits text into [{ text, match }] segments so the UI can highlight without innerHTML. */
export function splitHighlight(text, terms) {
  if (!terms.length) return [{ text, match: false }];
  const re = new RegExp(`(${[...terms].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})`, 'gi');
  return text
    .split(re)
    .filter((part) => part !== '')
    .map((part, i) => ({ text: part, match: i % 2 === 1 }));
}

/** A short plain-text excerpt around the first term found in content. */
export function makeSnippet(content, terms, radius = 70) {
  const flat = (s) => s.replace(/\s+/g, ' ').trim();
  const lower = content.toLowerCase();
  let at = -1;
  let len = 0;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (at === -1 || i < at)) {
      at = i;
      len = t.length;
    }
  }
  if (at === -1) {
    const head = flat(content.slice(0, radius * 2));
    return head.length < content.trim().length ? `${head}…` : head;
  }
  const start = Math.max(0, at - radius);
  const end = Math.min(content.length, at + len + radius);
  return `${start > 0 ? '…' : ''}${flat(content.slice(start, end))}${end < content.length ? '…' : ''}`;
}

function countOccurrences(haystack, needle, cap) {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1 && n < cap) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

export function createSearchService(db) {
  /**
   * Simple full scan, which is plenty for a personal knowledge base.
   * Every term must appear in the title, the content, or the folder path of a note.
   */
  async function search(query, { limit = 50 } = {}) {
    const terms = tokenize(query);
    if (!terms.length) return { terms, notes: [], folders: [], truncated: false };

    const folders = await db.folders.toArray();
    const paths = buildPathMap(folders);
    const results = [];

    await db.notes.each((note) => {
      const title = note.title.toLowerCase();
      const content = note.content.toLowerCase();
      const folderPath = note.folderId != null ? paths.get(note.folderId) || [] : [];
      const pathText = folderPath.join(' / ').toLowerCase();

      let score = 0;
      const where = new Set();
      for (const t of terms) {
        let hit = false;
        if (title.includes(t)) {
          score += title.startsWith(t) ? 15 : 10;
          where.add('title');
          hit = true;
        }
        if (pathText.includes(t)) {
          score += 3;
          where.add('folder');
          hit = true;
        }
        const n = countOccurrences(content, t, 5);
        if (n) {
          score += n;
          where.add('content');
          hit = true;
        }
        if (!hit) return; // AND semantics
      }
      results.push({
        type: 'note',
        id: note.id,
        title: note.title,
        folderId: note.folderId ?? null,
        path: folderPath,
        snippet: makeSnippet(note.content, terms),
        matchedIn: [...where],
        score,
        updatedAt: note.updatedAt,
      });
    });

    results.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);

    const folderHits = folders
      .filter((f) => terms.every((t) => f.name.toLowerCase().includes(t)))
      .map((f) => ({ type: 'folder', id: f.id, name: f.name, path: (paths.get(f.id) || []).slice(0, -1) }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return { terms, notes: results.slice(0, limit), folders: folderHits, truncated: results.length > limit };
  }

  return { search };
}
