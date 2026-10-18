import { Marked } from '../vendor/marked.mjs';
import DOMPurify from '../vendor/purify.mjs';
import hljs from '../vendor/highlight.mjs';

// Markdown -> HTML -> DOMPurify -> DOM nodes. The sanitised fragment is inserted
// directly into the page (never re-serialised and re-parsed), which avoids
// mutation-XSS round trips. Policy:
//   * HTML profile only (no SVG/MathML), no forms, no <style>, no inline styles
//   * no id/name attributes (stops DOM clobbering and clashes with app element ids)
//   * class only on code highlighting elements, and only highlight.js class names
//   * links: http(s) open in a new tab with noopener; mailto/tel kept; everything else loses its href
//   * images: only inline data:image/* is shown; remote images are NOT fetched (they would
//     leak that a note was opened) and are replaced by a plain link
//   * only checkbox inputs survive (task lists)

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const language = String(lang || '').trim().split(/\s+/)[0].toLowerCase();
      if (language && hljs.getLanguage(language)) {
        const body = hljs.highlight(text, { language, ignoreIllegals: true }).value;
        const safeLang = language.replace(/[^a-z0-9_+-]/g, '');
        return `<pre><code class="hljs language-${safeLang}">${body}\n</code></pre>`;
      }
      return `<pre><code>${escapeHtml(text)}\n</code></pre>`;
    },
  },
});

const CLASS_OK = /^(hljs|language-[a-z0-9_+-]+|hljs-[a-z0-9_-]+)( (hljs|language-[a-z0-9_+-]+|hljs-[a-z0-9_-]+))*$/;
const CLASS_TAGS = new Set(['CODE', 'SPAN', 'PRE']);
const SAFE_IMAGE = /^data:image\/(png|jpe?g|gif|webp|avif);/i;

let purify = null;

function getPurify() {
  if (purify) return purify;
  if (typeof window === 'undefined') return null;
  const instance = DOMPurify(window); // own instance, so hooks stay private to this module
  if (!instance.isSupported) return null;
  instance.addHook('uponSanitizeAttribute', (node, data) => {
    if (data.attrName === 'class') {
      if (!CLASS_TAGS.has(node.nodeName) || !CLASS_OK.test(data.attrValue)) data.keepAttr = false;
    }
  });
  purify = instance;
  return purify;
}

const PURIFY_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'option', 'link', 'meta', 'iframe', 'object', 'embed'],
  FORBID_ATTR: ['style', 'id', 'name'],
  ALLOW_DATA_ATTR: false,
  RETURN_DOM_FRAGMENT: true,
};

function tidy(fragment, doc) {
  for (const input of [...fragment.querySelectorAll('input')]) {
    if (input.getAttribute('type') !== 'checkbox') input.remove();
    else input.setAttribute('disabled', '');
  }
  for (const a of [...fragment.querySelectorAll('a')]) {
    const href = a.getAttribute('href');
    if (href == null) continue;
    if (/^https?:/i.test(href)) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    } else if (!/^(mailto|tel):/i.test(href)) {
      a.removeAttribute('href'); // relative or fragment links would navigate away from the app
    }
  }
  for (const img of [...fragment.querySelectorAll('img')]) {
    const src = img.getAttribute('src') || '';
    if (SAFE_IMAGE.test(src)) continue;
    const alt = img.getAttribute('alt') || 'image';
    const replacement = doc.createElement(/^https?:/i.test(src) ? 'a' : 'span');
    replacement.textContent = `Image: ${alt}`;
    replacement.className = '';
    if (replacement.tagName === 'A') {
      replacement.setAttribute('href', src);
      replacement.setAttribute('target', '_blank');
      replacement.setAttribute('rel', 'noopener noreferrer');
      replacement.setAttribute('title', 'Remote images are not loaded. Click to open.');
    }
    img.replaceWith(replacement);
  }
}

/** Renders Markdown into `element` (replacing its children). Safe for untrusted input. */
export function renderMarkdownInto(element, source) {
  const sanitizer = getPurify();
  if (!sanitizer) {
    // No DOM sanitiser available: show the source as inert text rather than risk raw HTML.
    const pre = element.ownerDocument.createElement('pre');
    pre.textContent = String(source ?? '');
    element.replaceChildren(pre);
    return;
  }
  const html = marked.parse(String(source ?? ''), { async: false });
  const fragment = sanitizer.sanitize(html, PURIFY_CONFIG);
  tidy(fragment, element.ownerDocument);
  element.replaceChildren(fragment);
}
