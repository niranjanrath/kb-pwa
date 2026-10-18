// Optional starter content, offered from the empty state. It is plain data that is
// written through the normal services, so nothing in the app depends on it.

const welcome = `# Welcome

Everything here is stored **only in this browser** (IndexedDB). Nothing is sent anywhere.

## Quick tips
- **New note**: button above, or press \`Alt+N\`
- **Search**: \`Ctrl/Cmd+K\` searches titles, content and folder names
- Notes save automatically as you type
- Back up regularly: *More → Export everything (ZIP)* or *Backup (JSON)*

## Markdown samples
- [x] Checklists
- [ ] Tables, quotes and code

> Blockquotes work too.

| Syntax | Result |
| ------ | ------ |
| \`**bold**\` | **bold** |
| \`*italic*\` | *italic* |

\`\`\`js
// fenced code is highlighted
const greet = (name) => \`Hello, \${name}\`;
\`\`\`
`;

export const SAMPLE_TREE = {
  notes: [{ title: 'Welcome', content: welcome }],
  folders: [
    {
      name: 'Architecture',
      notes: [
        { title: 'Software Architecture', content: '# Software Architecture\n\n' },
        { title: 'C4 Model', content: '# C4 Model\n\nContext, Containers, Components, Code.\n' },
      ],
      folders: [
        {
          name: 'Design Patterns',
          notes: [
            { title: 'Hexagonal Architecture', content: '# Hexagonal Architecture\n\nPorts and adapters.\n' },
            { title: 'CQRS', content: '# CQRS\n\nSeparate the write model from the read model.\n' },
          ],
        },
      ],
    },
    {
      name: 'Engineering',
      folders: [
        {
          name: 'Java',
          notes: [
            { title: 'Spring Boot', content: '# Spring Boot\n' },
            { title: 'Testing', content: '# Testing\n' },
          ],
        },
        { name: 'DevOps', notes: [{ title: 'CI-CD', content: '# CI/CD\n' }] },
      ],
    },
    {
      name: 'Security',
      notes: [
        { title: 'OAuth2', content: '# OAuth2\n' },
        { title: 'Threat Modeling', content: '# Threat Modeling\n' },
      ],
    },
    {
      name: 'AI',
      notes: [
        { title: 'RAG', content: '# RAG\n' },
        { title: 'AI Agents', content: '# AI Agents\n' },
      ],
    },
  ],
};

/** Writes a { notes, folders } description below parentId using the real services. */
export async function seed(folderService, noteService, tree = SAMPLE_TREE, parentId = null) {
  let firstNoteId = null;
  for (const n of tree.notes || []) {
    const note = await noteService.create({ folderId: parentId, title: n.title, content: n.content });
    if (firstNoteId == null) firstNoteId = note.id;
  }
  for (const f of tree.folders || []) {
    const folder = await folderService.create(f.name, parentId);
    await seed(folderService, noteService, f, folder.id);
  }
  return firstNoteId;
}
