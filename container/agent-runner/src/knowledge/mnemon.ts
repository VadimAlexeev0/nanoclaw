import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface KnowledgeConfig {
  enabled: boolean;
  vaultPath: string;
  mnemonDataDir: string;
  mnemonStore: string;
  recallLimit: number;
}

export interface RecallItem {
  id?: string;
  content: string;
  category?: string;
  importance?: number;
  score?: number;
  source?: string;
  tags?: string[];
  entities?: string[];
}

export async function mnemonAvailable(): Promise<boolean> {
  try {
    await execFileAsync('mnemon', ['--version'], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

export async function recall(query: string, config: KnowledgeConfig): Promise<RecallItem[]> {
  if (!config.enabled || !query.trim()) return [];
  try {
    const { stdout } = await execFileAsync('mnemon', [
      '--data-dir',
      config.mnemonDataDir,
      '--store',
      config.mnemonStore,
      'recall',
      query,
      '--limit',
      String(config.recallLimit),
    ], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        MNEMON_DATA_DIR: config.mnemonDataDir,
        MNEMON_STORE: config.mnemonStore,
      },
    });
    return parseRecall(stdout);
  } catch {
    return [];
  }
}

function parseRecall(stdout: string): RecallItem[] {
  const parsed = JSON.parse(stdout) as unknown;
  const raw = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { results?: unknown[] }).results)
      ? (parsed as { results: unknown[] }).results
      : [];

  return raw.map((entry) => {
    const r = entry as Record<string, unknown>;
    const insight = (r.insight && typeof r.insight === 'object' ? r.insight : r) as Record<string, unknown>;
    return {
      id: typeof insight.id === 'string' ? insight.id : undefined,
      content: typeof insight.content === 'string' ? insight.content : JSON.stringify(insight),
      category: typeof insight.category === 'string' ? insight.category : undefined,
      importance: typeof insight.importance === 'number' ? insight.importance : undefined,
      score: typeof r.score === 'number' ? r.score : undefined,
      source: typeof insight.source === 'string' ? insight.source : undefined,
      tags: Array.isArray(insight.tags) ? insight.tags.filter((x): x is string => typeof x === 'string') : undefined,
      entities: Array.isArray(insight.entities)
        ? insight.entities.filter((x): x is string => typeof x === 'string')
        : undefined,
    };
  }).filter((item) => item.content.trim());
}

export async function remember(args: {
  content: string;
  category?: string;
  importance?: number;
  tags?: string[];
  entities?: string[];
  source?: string;
  config: KnowledgeConfig;
}): Promise<string> {
  const cmd = [
    '--data-dir',
    args.config.mnemonDataDir,
    '--store',
    args.config.mnemonStore,
    'remember',
    args.content,
    '--cat',
    args.category || 'general',
    '--imp',
    String(args.importance || 3),
    '--source',
    args.source || 'agent',
  ];
  if (args.tags?.length) cmd.push('--tags', args.tags.join(','));
  if (args.entities?.length) cmd.push('--entities', args.entities.join(','));
  const { stdout } = await execFileAsync('mnemon', cmd, {
    timeout: 10000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      MNEMON_DATA_DIR: args.config.mnemonDataDir,
      MNEMON_STORE: args.config.mnemonStore,
    },
  });
  return stdout;
}
