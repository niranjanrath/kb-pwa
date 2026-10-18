import { el, icon } from './ui.js';

// Renders the folder/note tree as a flat list of ARIA treeitems (flat lists keep keyboard
// navigation and focus restoration simple) and wires click, keyboard and drag-and-drop.
// It owns no data: the app passes in the tree and handles every action.

export const keyOf = (type, id) => `${type}:${id ?? 'root'}`;

export function createTreeView(container, handlers) {
  let rows = []; // [{ key, type, id, level, node }]
  let dragItem = null;
  let focusKey = keyOf('folder', null);

  function flatten(root, { expanded }) {
    const out = [];
    out.push({ type: 'folder', id: null, name: root.name, level: 1, isRoot: true, hasContent: true, open: true, parentKey: null });
    const walk = (node, level, parentKey) => {
      for (const folder of node.children) {
        const hasContent = folder.children.length > 0 || folder.notes.length > 0;
        const open = hasContent && expanded.has(folder.id);
        out.push({ type: 'folder', id: folder.id, name: folder.name, level, hasContent, open, parentKey });
        if (open) walk(folder, level + 1, keyOf('folder', folder.id));
      }
      for (const note of node.notes) {
        out.push({ type: 'note', id: note.id, name: note.title, level, folderId: node.id, parentKey });
      }
    };
    walk(root, 2, keyOf('folder', null));
    return out;
  }

  function render(root, { expanded, selected, emptyNode }) {
    const hadFocus = container.contains(document.activeElement);
    const flat = flatten(root, { expanded });
    if (!flat.some((r) => keyOf(r.type, r.id) === focusKey)) focusKey = keyOf('folder', null);

    rows = flat.map((r) => {
      const key = keyOf(r.type, r.id);
      const isSelected = selected && selected.type === r.type && (selected.id ?? null) === (r.id ?? null);
      const node = el(
        'div',
        {
          class: `row ${r.type}${r.isRoot ? ' root' : ''}${isSelected ? ' selected' : ''}`,
          role: 'treeitem',
          tabindex: key === focusKey ? '0' : '-1',
          'aria-level': String(r.level),
          'aria-selected': String(Boolean(isSelected)),
          'aria-expanded': r.type === 'folder' && r.hasContent && !r.isRoot ? String(r.open) : null,
          draggable: r.isRoot ? null : 'true',
          dataset: { key, type: r.type, id: r.id ?? '', folderId: r.type === 'note' ? (r.folderId ?? '') : '' },
        },
        el('span', { class: `twisty${r.type === 'folder' && r.hasContent && !r.isRoot ? '' : ' none'}${r.open ? ' open' : ''}` }, r.type === 'folder' && r.hasContent && !r.isRoot ? icon('chevron', 14) : null),
        el('span', { class: 'row-icon' }, icon(r.type === 'folder' ? 'folder' : 'note', 16)),
        el('span', { class: 'label' }, r.name),
      );
      node.style.setProperty('--depth', r.level - 1);
      return { ...r, key, node };
    });

    container.replaceChildren(...rows.map((r) => r.node), ...(emptyNode ? [emptyNode] : []));
    if (hadFocus) container.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  }

  const info = (node) => ({
    type: node.dataset.type,
    id: node.dataset.id === '' ? null : Number(node.dataset.id),
    folderId: node.dataset.folderId === '' ? null : Number(node.dataset.folderId),
  });
  const rowEl = (target) => target.closest?.('.row') || null;
  const indexOf = (node) => rows.findIndex((r) => r.node === node);

  function focusRow(index) {
    const r = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (!r) return;
    focusKey = r.key;
    for (const x of rows) x.node.tabIndex = x === r ? 0 : -1;
    r.node.focus();
  }

  // ----- click & keyboard -----
  container.addEventListener('click', (e) => {
    const node = rowEl(e.target);
    if (!node) return;
    const item = info(node);
    focusKey = node.dataset.key;
    if (item.type === 'folder' && e.target.closest('.twisty:not(.none)')) {
      handlers.onToggle(item.id);
      return;
    }
    handlers.onActivate(item, { fromClick: true });
  });

  container.addEventListener('keydown', (e) => {
    const node = rowEl(e.target);
    if (!node || e.altKey || e.ctrlKey || e.metaKey) return;
    const i = indexOf(node);
    const row = rows[i];
    const item = info(node);
    switch (e.key) {
      case 'ArrowDown': focusRow(i + 1); break;
      case 'ArrowUp': focusRow(i - 1); break;
      case 'Home': focusRow(0); break;
      case 'End': focusRow(rows.length - 1); break;
      case 'ArrowRight':
        if (row.type === 'folder' && row.hasContent && !row.isRoot) {
          if (!row.open) handlers.onToggle(item.id);
          else focusRow(i + 1);
        }
        break;
      case 'ArrowLeft':
        if (row.type === 'folder' && row.open && !row.isRoot) handlers.onToggle(item.id);
        else if (row.parentKey) focusRow(rows.findIndex((r) => r.key === row.parentKey));
        break;
      case 'Enter':
      case ' ':
        handlers.onActivate(item, { fromClick: false });
        break;
      case 'F2':
        if (!row.isRoot) handlers.onRename(item);
        break;
      case 'Delete':
        if (!row.isRoot) handlers.onDelete(item);
        break;
      default:
        return;
    }
    e.preventDefault();
  });

  // ----- drag and drop -----
  function dropTargetFolder(node) {
    if (!node) return undefined; // empty area of the tree: root
    const item = info(node);
    return item.type === 'folder' ? item.id : item.folderId;
  }

  container.addEventListener('dragstart', (e) => {
    const node = rowEl(e.target);
    if (!node || node.classList.contains('root')) return e.preventDefault();
    dragItem = info(node);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', node.querySelector('.label').textContent);
    node.classList.add('dragging');
  });

  const clearTargets = () => container.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));

  container.addEventListener('dragover', (e) => {
    if (!dragItem) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearTargets();
    const node = rowEl(e.target);
    const folderId = dropTargetFolder(node);
    const targetNode = node
      ? node.dataset.type === 'folder'
        ? node
        : container.querySelector(`[data-key="${CSS.escape(keyOf('folder', info(node).folderId))}"]`)
      : container.querySelector('.row.root');
    if (folderId !== undefined || !node) targetNode?.classList.add('drop-target');
  });

  container.addEventListener('dragleave', (e) => {
    if (!container.contains(e.relatedTarget)) clearTargets();
  });

  container.addEventListener('drop', (e) => {
    if (!dragItem) return;
    e.preventDefault();
    const item = dragItem;
    const node = rowEl(e.target);
    const folderId = node ? dropTargetFolder(node) : null;
    clearTargets();
    dragItem = null;
    container.querySelector('.dragging')?.classList.remove('dragging');
    handlers.onMove(item, folderId);
  });

  container.addEventListener('dragend', () => {
    dragItem = null;
    clearTargets();
    container.querySelector('.dragging')?.classList.remove('dragging');
  });

  /** Scrolls a row into view and briefly highlights it. */
  function reveal(type, id) {
    const node = container.querySelector(`[data-key="${CSS.escape(keyOf(type, id))}"]`);
    if (!node) return;
    focusKey = node.dataset.key;
    for (const x of rows) x.node.tabIndex = x.node === node ? 0 : -1;
    node.scrollIntoView({ block: 'nearest' });
    node.classList.remove('flash');
    void node.offsetWidth; // restart the animation
    node.classList.add('flash');
  }

  function setLabel(type, id, text) {
    const node = container.querySelector(`[data-key="${CSS.escape(keyOf(type, id))}"] .label`);
    if (node) node.textContent = text;
  }

  return { render, reveal, setLabel, focusSelected: () => container.querySelector('.row[tabindex="0"]')?.focus() };
}
