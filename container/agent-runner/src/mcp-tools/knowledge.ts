import fs from 'fs';
import path from 'path';

import { getConfig } from '../config.js';
import { remember } from '../knowledge/mnemon.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function safeVaultPath(rel: string): string | undefined {
  const vault = getConfig().knowledge.vaultPath;
  const full = path.resolve(vault, rel);
  if (!full.startsWith(path.resolve(vault) + path.sep) && full !== path.resolve(vault)) return undefined;
  return full;
}

const rememberTool: McpToolDefinition = {
  tool: {
    name: 'knowledge_remember',
    description: 'Store an atomic long-lived fact, preference, decision, insight, or context note in mnemon.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: 'Self-contained memory statement' },
        category: { type: 'string', description: 'preference, decision, fact, insight, context, or general' },
        importance: { type: 'number', description: 'Importance 1-5' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
        entities: { type: 'array', items: { type: 'string' }, description: 'Optional entities' },
        source: { type: 'string', description: 'user, agent, or external' },
      },
      required: ['content'],
    },
  },
  async handler(args) {
    const content = args.content as string;
    if (!content?.trim()) return err('content is required');
    try {
      const out = await remember({
        content,
        category: args.category as string | undefined,
        importance: args.importance as number | undefined,
        tags: args.tags as string[] | undefined,
        entities: args.entities as string[] | undefined,
        source: args.source as string | undefined,
        config: getConfig().knowledge,
      });
      return ok(out.trim() || 'Stored memory.');
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

const writeWikiTool: McpToolDefinition = {
  tool: {
    name: 'knowledge_write_note',
    description: 'Create or replace a markdown note inside the Obsidian vault.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Vault-relative markdown path, e.g. Wiki/Entities/Foo.md' },
        content: { type: 'string', description: 'Complete markdown content' },
      },
      required: ['path', 'content'],
    },
  },
  async handler(args) {
    const rel = args.path as string;
    const content = args.content as string;
    if (!rel || !content) return err('path and content are required');
    if (path.isAbsolute(rel) || rel.includes('..')) return err('path must be vault-relative');
    const full = safeVaultPath(rel);
    if (!full) return err('path escapes vault');
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content.endsWith('\n') ? content : `${content}\n`);
    return ok(`Wrote ${rel}`);
  },
};

const appendLogTool: McpToolDefinition = {
  tool: {
    name: 'knowledge_append_log',
    description: 'Append an entry to Wiki/Log.md in the Obsidian vault.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Short log title' },
        body: { type: 'string', description: 'Markdown log body' },
      },
      required: ['title', 'body'],
    },
  },
  async handler(args) {
    const full = safeVaultPath('Wiki/Log.md');
    if (!full) return err('vault not configured');
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(full, `\n## [${date}] ${args.title as string}\n\n${args.body as string}\n`);
    return ok('Appended Wiki/Log.md');
  },
};

registerTools([rememberTool, writeWikiTool, appendLogTool]);
