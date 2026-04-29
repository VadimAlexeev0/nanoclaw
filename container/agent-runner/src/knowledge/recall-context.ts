import { getConfig } from '../config.js';
import { recall } from './mnemon.js';

export async function buildKnowledgeContext(prompt: string): Promise<string | undefined> {
  const config = getConfig().knowledge;
  if (!config.enabled) return undefined;
  const memories = await recall(extractQuery(prompt), config);
  if (memories.length === 0) return undefined;

  const lines = memories.slice(0, config.recallLimit).map((m, i) => {
    const meta = [
      m.category,
      m.importance ? `imp=${m.importance}` : undefined,
      m.source ? `source=${m.source}` : undefined,
    ].filter(Boolean).join(', ');
    return `${i + 1}. ${m.content}${meta ? ` (${meta})` : ''}`;
  });

  return `<system-reminder>\nRelevant persistent memory from mnemon (${config.mnemonStore}):\n${lines.join('\n')}\n\nUse this as background context. Cite memory only when it materially affects the answer.\n</system-reminder>`;
}

function extractQuery(prompt: string): string {
  return prompt.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(-2000);
}
