import fs from 'fs';
import path from 'path';

import { initDb } from '../../src/db/connection.js';
import { getActiveSessions } from '../../src/db/sessions.js';
import { DATA_DIR } from '../../src/config.js';
import { initSessionFolder, writeSessionMessage } from '../../src/session-manager.js';

const vault = process.env.NANOCLAW_OBSIDIAN_VAULT || '/srv/obsidian';
const inbox = path.join(vault, 'Inbox');
const logPath = path.join(vault, 'System', 'Ingest Queue.md');
const processedDir = path.join(inbox, 'Processed');
const failedDir = path.join(inbox, 'Failed');
const dbPath = path.join(DATA_DIR, 'v2.db');

initDb(dbPath);

fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.mkdirSync(processedDir, { recursive: true });
fs.mkdirSync(failedDir, { recursive: true });
fs.appendFileSync(logPath, `\n## [${new Date().toISOString()}] watcher-start\n\nWatching ${inbox}\n`);

const seen = new Set<string>();
for (const file of walk(inbox)) seen.add(file);

setInterval(() => {
  for (const file of walk(inbox)) {
    if (seen.has(file)) continue;
    seen.add(file);
    if (file.includes(`${path.sep}Processed${path.sep}`) || file.includes(`${path.sep}Failed${path.sep}`)) continue;
    if (!isIngestable(file)) continue;
  const rel = path.relative(vault, file);
    queueIngest(file, rel).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      fs.appendFileSync(logPath, `\n## [${new Date().toISOString()}] failed | ${rel}\n\n${msg}\n`);
      moveTo(file, failedDir);
    });
  }
}, 5000);

async function queueIngest(file: string, rel: string): Promise<void> {
  const session = chooseSession();
  if (!session) throw new Error('No active NanoClaw session found for knowledge ingest.');
  initSessionFolder(session.agent_group_id, session.id);

  const queuedRel = moveTo(file, processedDir);
  const target = sourceTarget(file);
  const msgId = `knowledge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeSessionMessage(session.agent_group_id, session.id, {
    id: msgId,
    kind: 'task',
    timestamp: new Date().toISOString(),
    platformId: 'knowledge',
    channelType: 'system',
    threadId: null,
    content: JSON.stringify({
      prompt: `Ingest the Obsidian source at /workspace/knowledge/obsidian/${queuedRel}.

Process it according to the knowledge skill:
1. Read the source fully.
2. Store durable atomic facts with knowledge_remember.
3. Move or copy the source into the appropriate Sources folder if useful: ${target}.
4. Update Wiki/Entities, Wiki/Concepts, Wiki/Timelines, Wiki/Questions, Wiki/Index.md, and Wiki/Log.md as relevant.
5. Keep the response concise and include what changed.`,
    }),
  });
  fs.appendFileSync(logPath, `\n## [${new Date().toISOString()}] queued | ${rel}\n\nSession: ${session.id}\nSource: ${queuedRel}\n`);
}

function chooseSession() {
  const preferred = process.env.NANOCLAW_KNOWLEDGE_SESSION_ID;
  const active = getActiveSessions();
  if (preferred) return active.find((s) => s.id === preferred);
  return active.sort((a, b) => (b.last_active || b.created_at).localeCompare(a.last_active || a.created_at))[0];
}

function isIngestable(file: string): boolean {
  return /\.(md|markdown|txt)$/i.test(file);
}

function sourceTarget(file: string): string {
  if (/clip/i.test(file)) return 'Sources/Articles';
  return 'Sources/Notes';
}

function moveTo(file: string, dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${Date.now()}-${path.basename(file)}`);
  fs.renameSync(file, dest);
  return path.relative(vault, dest);
}

function* walk(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = fs.statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else yield full;
  }
}
