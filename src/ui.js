// Small DOM helpers shared by the UI modules: icons, toasts, dialogs, downloads, formatting.
// Nothing here talks to the database.

const SVG_NS = 'http://www.w3.org/2000/svg';

const ICON_PATHS = {
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v6M9 14h6"/>',
  note: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>',
  move: '<path d="M15 10l5 5-5 5"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  download: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/>',
  upload: '<path d="M12 15V3"/><path d="M7 8l5-5 5 5"/><path d="M5 21h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
};

/** Returns an <svg> element for a named icon (static markup only, never user data). */
export function icon(name, size = 18) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.innerHTML = ICON_PATHS[name] || '';
  return svg;
}

/** Replaces the placeholder `<span data-icon="name">` elements declared in the HTML. */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    el.replaceChildren(icon(el.dataset.icon, Number(el.dataset.size) || 18));
  }
}

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

// ---------- toasts ----------

export function toast(message, { type = 'info', timeout } = {}) {
  const host = document.getElementById('toasts');
  const node = el('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' }, message);
  const remove = () => node.remove();
  node.addEventListener('click', remove);
  host.append(node);
  setTimeout(remove, timeout ?? (type === 'error' ? 9000 : 3500));
  return node;
}

// ---------- dialogs ----------

function showDialog({ title, body = [], confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false, focus = 'input', alertOnly = false, getValue }) {
  return new Promise((resolve) => {
    const dialog = el('dialog', { class: 'dialog', 'aria-labelledby': 'dialog-title' });
    const form = el('form', { novalidate: true });
    const confirm = el('button', { type: 'submit', class: danger ? 'btn danger' : 'btn primary' }, confirmLabel);
    const cancel = alertOnly ? null : el('button', { type: 'button', class: 'btn', value: 'cancel' }, cancelLabel);
    form.append(
      el('h2', { id: 'dialog-title' }, title),
      el('div', { class: 'dialog-body' }, ...body),
      el('div', { class: 'dialog-actions' }, cancel, confirm),
    );
    dialog.append(form);

    let result = null;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      result = getValue ? getValue(form) : true;
      dialog.close();
    });
    cancel?.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog && !alertOnly) dialog.close(); // click on backdrop
    });

    document.body.append(dialog);
    dialog.showModal();
    const target = focus === 'cancel' && cancel ? cancel : form.querySelector('input, select, textarea') || confirm;
    target.focus();
    if (target.select && target.tagName === 'INPUT') target.select();
  });
}

/** Resolves to the entered string, or null when cancelled. `error` shows a message above the buttons. */
export function promptDialog({ title, label, value = '', confirmLabel = 'Save', hint, error }) {
  const input = el('input', { type: 'text', name: 'value', autocomplete: 'off', spellcheck: 'false', maxlength: 200, 'aria-label': label });
  input.value = value;
  const body = [
    el('label', { class: 'field' }, el('span', {}, label), input),
    hint ? el('p', { class: 'hint' }, hint) : null,
    error ? el('p', { class: 'field-error', role: 'alert' }, error) : null,
  ];
  return showDialog({ title, body, confirmLabel, getValue: () => input.value });
}

/** Resolves to true when confirmed. Destructive dialogs focus Cancel first. */
export function confirmDialog({ title, message, confirmLabel = 'OK', danger = false }) {
  return showDialog({
    title,
    body: [el('p', {}, message)],
    confirmLabel,
    danger,
    focus: danger ? 'cancel' : 'confirm',
  }).then((v) => v === true);
}

export function alertDialog({ title, lines = [], details = [] }) {
  const body = lines.map((l) => el('p', {}, l));
  if (details.length) {
    body.push(el('details', {}, el('summary', {}, `${details.length} skipped item${details.length === 1 ? '' : 's'}`), el('ul', { class: 'detail-list' }, ...details.slice(0, 50).map((d) => el('li', {}, d)))));
  }
  return showDialog({ title, body, confirmLabel: 'OK', alertOnly: true, focus: 'confirm' });
}

/** options: [{ value, label, disabled }]. Resolves to the chosen value ('' for root) or null. */
export function selectDialog({ title, label, options, value = '', confirmLabel = 'Move here' }) {
  const select = el('select', { name: 'value', 'aria-label': label });
  for (const o of options) {
    const opt = el('option', { value: String(o.value), disabled: o.disabled }, o.label);
    opt.selected = String(o.value) === String(value);
    select.append(opt);
  }
  return showDialog({
    title,
    body: [el('label', { class: 'field' }, el('span', {}, label), select)],
    confirmLabel,
    getValue: () => select.value,
  });
}

// ---------- files & formatting ----------

export function downloadBlob(data, filename, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const timeOnly = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' });
export const formatDateTime = (ts) => dateTime.format(new Date(ts));
export const formatTime = (ts) => timeOnly.format(new Date(ts));

export function isoDay(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

export function safeStorage() {
  // localStorage can throw (blocked cookies, private modes); preferences are optional.
  return {
    get(key, fallback = null) {
      try {
        const v = localStorage.getItem(key);
        return v == null ? fallback : v;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* ignore */
      }
    },
  };
}
