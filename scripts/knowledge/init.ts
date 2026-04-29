import fs from 'fs';
import path from 'path';

const vault = process.env.NANOCLAW_OBSIDIAN_VAULT || '/srv/obsidian';
const mnemon = process.env.MNEMON_DATA_DIR || '/srv/mnemon';
const backups = process.env.NANOCLAW_KNOWLEDGE_BACKUPS || '/srv/backups';

const dirs = [
  path.join(vault, 'Inbox', 'Clips'),
  path.join(vault, 'Inbox', 'Imports'),
  path.join(vault, 'Inbox', 'Attachments'),
  path.join(vault, 'Inbox', 'Processed'),
  path.join(vault, 'Inbox', 'Failed'),
  path.join(vault, 'Sources', 'Articles'),
  path.join(vault, 'Sources', 'Transcripts'),
  path.join(vault, 'Sources', 'Notes'),
  path.join(vault, 'Sources', 'PDFs'),
  path.join(vault, 'Sources', 'Media'),
  path.join(vault, 'Wiki', 'Entities'),
  path.join(vault, 'Wiki', 'Concepts'),
  path.join(vault, 'Wiki', 'Timelines'),
  path.join(vault, 'Wiki', 'Questions'),
  path.join(vault, 'System'),
  mnemon,
  path.join(backups, 'obsidian'),
  path.join(backups, 'mnemon'),
];

for (const dir of dirs) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES') {
      console.error(`Cannot create ${dir}; create it once with sudo and rerun this script.`);
      continue;
    }
    throw err;
  }
}

writeIfMissing(path.join(vault, 'Wiki', 'Home.md'), `---
type: knowledge-home
---

# Knowledge Home

This is Vadim's personal knowledge base maintained by NanoClaw.
`);

writeIfMissing(path.join(vault, 'Wiki', 'Index.md'), `---
type: knowledge-index
---

# Knowledge Index

## Entities

## Concepts

## Timelines

## Questions
`);

writeIfMissing(path.join(vault, 'Wiki', 'Log.md'), `---
type: knowledge-log
---

# Knowledge Log
`);

writeIfMissing(path.join(vault, 'System', 'NanoClaw.md'), `---
type: system
---

# NanoClaw Knowledge System

- Vault: ${vault}
- Mnemon data: ${mnemon}
- Backups: ${backups}
`);

function writeIfMissing(file: string, content: string): void {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`);
}

console.log(`Knowledge layout initialized:
vault=${vault}
mnemon=${mnemon}
backups=${backups}`);
