import * as fs from 'fs';
import { spawn, type ChildProcess } from 'child_process';

import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';
import OpenAI from 'openai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, McpServerConfig, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import { mcpServersToOpenCodeConfig } from './mcp-to-opencode.js';

function log(msg: string): void {
  console.error(`[opencode-provider] ${msg}`);
}

// ── Go direct API helpers ──

function isGoProvider(): boolean {
  return (process.env.OPENCODE_PROVIDER || '') === 'opencode-go';
}

function getGoModelId(): string {
  return (process.env.OPENCODE_MODEL || '').replace(/^opencode-go\//, '');
}

function isMiniMaxModel(model: string): boolean {
  return /(^|\/)minimax-/i.test(model);
}

/**
 * Extract <system>...</system> blocks from the front of a prompt for use as
 * OpenAI system messages. Returns the system parts and the remaining text.
 */
function extractSystemBlocks(text: string): { system: string[]; body: string } {
  const systemParts: string[] = [];
  const re = /<system>\s*([\s\S]*?)\s*<\/system>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    systemParts.push(m[1].trim());
  }
  const body = text.replace(re, '').replace(/^\n+/, '').trim();
  return { system: systemParts, body };
}

function generateGoSessionId(): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `go-${ts}-${rnd}`;
}

// ── Go runtime ──

interface GoMcpHandle {
  client: Client;
  transport: StdioClientTransport;
}

interface GoRuntime {
  openai: OpenAI;
  mcpClients: Map<string, GoMcpHandle>;
  toolDefs: OpenAI.Chat.Completions.ChatCompletionTool[];
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  sessionId: string;
  /** True once the first system+CLAUDE.md block has been prepended. */
  systemInitDone: boolean;
}

async function connectMcpServers(
  mcpServers: Record<string, McpServerConfig>,
): Promise<{ clients: Map<string, GoMcpHandle>; toolDefs: OpenAI.Chat.Completions.ChatCompletionTool[] }> {
  const clients = new Map<string, GoMcpHandle>();
  const toolDefs: OpenAI.Chat.Completions.ChatCompletionTool[] = [];

  for (const [name, config] of Object.entries(mcpServers)) {
    try {
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env,
      });
      const client = new Client(
        { name: 'nanoclaw-agent-runner', version: '1.0.0' },
        { capabilities: {} },
      );
      // connect with a generous timeout — MCP servers can take a moment
      await client.connect(transport, { timeout: 30_000 });

      const { tools } = await client.listTools({}, { timeout: 10_000 });
      for (const tool of tools) {
        toolDefs.push({
          type: 'function' as const,
          function: {
            name: `mcp__${name}__${tool.name}`,
            description: tool.description || `${name} / ${tool.name}`,
            parameters: (tool.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} },
          },
        });
      }
      clients.set(name, { client, transport });
      log(`Go MCP: connected "${name}" (${tools.length} tools)`);
    } catch (err) {
      log(`Go MCP: failed to connect "${name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { clients, toolDefs };
}

async function initGoRuntime(options: ProviderOptions): Promise<GoRuntime> {
  const modelId = getGoModelId();
  if (isMiniMaxModel(modelId)) {
    throw new Error(
      `OpenCode Go: MiniMax models use the Anthropic-format endpoint and are not supported via direct API. Model "${modelId}" is blocked.`,
    );
  }

  const apiKey = process.env.OPENCODE_GO_API_KEY;
  if (!apiKey) {
    throw new Error('OPENCODE_GO_API_KEY env var not set — required for Go direct API');
  }

  const openai = new OpenAI({
    apiKey,
    baseURL: 'https://opencode.ai/zen/go/v1',
  });

  const { clients: mcpClients, toolDefs } = await connectMcpServers(options.mcpServers ?? {});

  return {
    openai,
    mcpClients,
    toolDefs,
    messages: [],
    sessionId: generateGoSessionId(),
    systemInitDone: false,
  };
}

const SESSION_STATUS_RETRY_ERROR_AFTER = 3;

/** Stale / dead OpenCode session heuristics (complement Claude-centric host patterns). */
const STALE_SESSION_RE =
  /no conversation found|ENOENT.*\.jsonl|session.*not found|NotFoundError|connection reset|ECONNRESET|404|event timeout/i;

function spawnOpencodeServer(config: Record<string, unknown>, timeoutMs = 10_000): Promise<{ url: string; proc: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const hostname = '127.0.0.1';
    const port = 4096;
    const proc = spawn('opencode', ['serve', `--hostname=${hostname}`, `--port=${port}`], {
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      },
    });

    const id = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`Timeout waiting for OpenCode server to start after ${timeoutMs}ms`));
    }, timeoutMs);

    let output = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      for (const line of output.split('\n')) {
        if (line.startsWith('opencode server listening')) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (match) {
            clearTimeout(id);
            resolve({ url: match[1], proc });
          }
        }
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.on('exit', (code) => {
      clearTimeout(id);
      let msg = `OpenCode server exited with code ${code}`;
      if (output.trim()) msg += `\nServer output: ${output}`;
      reject(new Error(msg));
    });
    proc.on('error', (err) => {
      clearTimeout(id);
      reject(err);
    });
  });
}

function readClaudeMdForPrompt(): string | undefined {
  const groupPath = '/workspace/agent/CLAUDE.md';
  const globalPath = '/workspace/global/CLAUDE.md';
  let content = '';
  if (fs.existsSync(groupPath)) {
    content += fs.readFileSync(groupPath, 'utf-8');
  }
  const isMain = process.env.NANOCLAW_IS_MAIN === '1';
  if (!isMain && fs.existsSync(globalPath)) {
    if (content) content += '\n\n---\n\n';
    content += fs.readFileSync(globalPath, 'utf-8');
  }
  return content || undefined;
}

function wrapPromptWithContext(text: string, systemInstructions?: string): string {
  let out = text;
  if (systemInstructions) {
    out = `<system>\n${systemInstructions}\n</system>\n\n${out}`;
  }
  const claudeMd = readClaudeMdForPrompt();
  if (claudeMd) {
    out = `<system>\n${claudeMd}\n</system>\n\n${out}`;
  }
  return out;
}

function buildOpenCodeConfig(options: ProviderOptions): Record<string, unknown> {
  const provider = process.env.OPENCODE_PROVIDER || 'anthropic';
  const model = process.env.OPENCODE_MODEL;
  const smallModel = process.env.OPENCODE_SMALL_MODEL;
  const proxyUrl = process.env.ANTHROPIC_BASE_URL;

  const providerModelId = model ? model.replace(new RegExp(`^${provider}/`), '') : undefined;
  const providerSmallModelId = smallModel ? smallModel.replace(new RegExp(`^${provider}/`), '') : undefined;
  const modelsToRegister = [providerModelId, providerSmallModelId]
    .filter(Boolean)
    .filter((mid, i, a) => a.indexOf(mid as string) === i);

  const providerOptions: Record<string, unknown> =
    provider === 'anthropic'
      ? {}
      : {
          [provider]: {
            options: { apiKey: 'placeholder', baseURL: proxyUrl },
            ...(modelsToRegister.length > 0
              ? {
                  models: Object.fromEntries(
                    modelsToRegister.map((mid) => [mid, { id: mid, name: mid, tool_call: true }]),
                  ),
                }
              : {}),
          },
        };

  const mcp = mcpServersToOpenCodeConfig(options.mcpServers);

  return {
    ...(model ? { model } : {}),
    ...(smallModel ? { small_model: smallModel } : {}),
    enabled_providers: [provider],
    permission: 'allow',
    autoupdate: false,
    snapshot: false,
    provider: providerOptions,
    mcp,
  };
}

type SharedRuntime = {
  proc: ChildProcess;
  client: OpencodeClient;
  stream: AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
  streamRelease: () => void;
};

let sharedRuntime: SharedRuntime | null = null;
let sharedConfigKey: string | null = null;
let sharedInit: Promise<SharedRuntime> | null = null;

function runtimeConfigKey(options: ProviderOptions): string {
  return JSON.stringify({
    mcp: mcpServersToOpenCodeConfig(options.mcpServers),
    model: process.env.OPENCODE_MODEL,
    small: process.env.OPENCODE_SMALL_MODEL,
    op: process.env.OPENCODE_PROVIDER,
  });
}

async function ensureSharedRuntime(options: ProviderOptions): Promise<SharedRuntime> {
  const key = runtimeConfigKey(options);
  if (sharedRuntime && sharedConfigKey === key) return sharedRuntime;

  if (sharedInit) return sharedInit;

  sharedInit = (async () => {
    if (sharedRuntime) {
      destroySharedRuntime();
    }
    const config = buildOpenCodeConfig(options);
    const { url, proc } = await spawnOpencodeServer(config);
    const client = createOpencodeClient({ baseUrl: url });
    const sub = await client.event.subscribe();
    const stream = sub.stream as AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
    sharedRuntime = {
      proc,
      client,
      stream,
      streamRelease: () => {
        void stream.return?.(undefined);
      },
    };
    sharedConfigKey = key;
    sharedInit = null;
    return sharedRuntime;
  })();

  return sharedInit;
}

export function destroySharedRuntime(): void {
  if (sharedRuntime) {
    try {
      sharedRuntime.streamRelease();
    } catch {
      /* ignore */
    }
    try {
      sharedRuntime.proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    sharedRuntime = null;
    sharedConfigKey = null;
  }
  sharedInit = null;
}

function sessionErrorMessage(props: { error?: unknown }): string {
  const err = props.error as { data?: { message?: string } } | undefined;
  if (err && typeof err === 'object' && err.data && typeof err.data.message === 'string') {
    return err.data.message;
  }
  return JSON.stringify(props.error) || 'OpenCode session error';
}

export class OpenCodeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly options: ProviderOptions;
  private activeSessionId: string | undefined;

  // Go direct API state
  private goRuntime: GoRuntime | null = null;
  private goInitPromise: Promise<GoRuntime> | null = null;
  private goInitError: string | null = null;

  constructor(options: ProviderOptions = {}) {
    this.options = options;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    if (isGoProvider()) {
      return this._goQuery(input);
    }
    return this._serveQuery(input);
  }

  // ── Go direct API query ──

  private async _ensureGoRuntime(): Promise<GoRuntime> {
    if (this.goRuntime) return this.goRuntime;
    if (this.goInitPromise) return this.goInitPromise;

    if (this.goInitError) {
      throw new Error(`OpenCode Go: initialization failed — ${this.goInitError}`);
    }

    this.goInitPromise = (async () => {
      try {
        this.goRuntime = await initGoRuntime(this.options);
        this.goInitError = null;
        return this.goRuntime;
      } catch (err) {
        this.goInitError = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        this.goInitPromise = null;
      }
    })();

    return this.goInitPromise;
  }

  private _goQuery(input: QueryInput): AgentQuery {
    this.activeSessionId = undefined;

    const systemInstructions = input.systemContext?.instructions;
    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;

    pending.push(wrapPromptWithContext(input.prompt, systemInstructions));

    const kick = (): void => {
      waiting?.();
    };

    const self = this;
    const IDLE_TIMEOUT_MS = 90_000;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      yield { type: 'activity' };

      const rt = await self._ensureGoRuntime();

      // Handle continuation
      if (!input.continuation) {
        rt.messages = [];
        rt.sessionId = generateGoSessionId();
        rt.systemInitDone = false;
      } else if (input.continuation !== rt.sessionId) {
        rt.messages = [];
        rt.sessionId = input.continuation;
        rt.systemInitDone = false;
      }

      if (!rt.systemInitDone) {
        yield { type: 'init', continuation: rt.sessionId };
      }

      while (!aborted) {
        while (pending.length === 0 && !ended && !aborted) {
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }

        if (aborted) return;
        if (pending.length === 0 && ended) return;

        const text = pending.shift()!;

        // For the first message, extract system blocks and add as system messages
        if (!rt.systemInitDone) {
          const { system, body } = extractSystemBlocks(text);
          for (const s of system) {
            rt.messages.push({ role: 'system', content: s });
          }
          if (body) {
            rt.messages.push({ role: 'user', content: body });
          }
          rt.systemInitDone = true;
        } else {
          rt.messages.push({ role: 'user', content: text });
        }

        let lastEventAt = Date.now();
        let eventTimedOut = false;
        const timeoutCheck = setInterval(() => {
          if (Date.now() - lastEventAt > IDLE_TIMEOUT_MS) {
            log(`Go event timeout (${IDLE_TIMEOUT_MS}ms) — clearing session ${rt.sessionId}`);
            eventTimedOut = true;
            self.goRuntime = null;
            kick();
          }
        }, 5000);

        try {
          // Streaming + tool calling loop
          let turnDone = false;
          turnLoop: while (!turnDone && !aborted) {
            if (eventTimedOut) {
              throw new Error(`Go event timeout (${IDLE_TIMEOUT_MS}ms)`);
            }

            const stream = await rt.openai.chat.completions.create({
              model: getGoModelId(),
              messages: rt.messages,
              stream: true,
              ...(rt.toolDefs.length > 0 ? { tools: rt.toolDefs, tool_choice: 'auto' as const } : {}),
            });

            let content = '';
            let reasoningContent = '';
            const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
            let finishReason: string | null = null;

            for await (const chunk of stream) {
              if (aborted) return;
              lastEventAt = Date.now();
              yield { type: 'activity' };

              const choice = chunk.choices?.[0];
              if (!choice) continue;

              const delta = choice.delta as Record<string, unknown>;
              if (typeof delta.content === 'string') content += delta.content;
              if (typeof delta.reasoning_content === 'string') reasoningContent += delta.reasoning_content;

              if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
                  const idx = (tc.index as number) ?? 0;
                  if (!toolCalls.has(idx)) {
                    toolCalls.set(idx, {
                      id: (tc.id as string) || '',
                      name: ((tc.function as Record<string, unknown>)?.name as string) || '',
                      arguments: '',
                    });
                  }
                  const t = toolCalls.get(idx)!;
                  if (tc.id) t.id = tc.id as string;
                  const fn = tc.function as Record<string, unknown> | undefined;
                  if (fn?.name) t.name = fn.name as string;
                  if (typeof fn?.arguments === 'string') t.arguments += fn.arguments;
                }
              }

              finishReason = (choice as unknown as Record<string, unknown>).finish_reason as string || finishReason;
            }

            // Sort tool calls by index
            const sortedToolCalls = [...toolCalls.entries()]
              .sort(([a], [b]) => a - b)
              .map(([, tc]) => tc);

            // Build assistant message, preserving reasoning_content
            const assistantMsg: Record<string, unknown> = {
              role: 'assistant',
              content: content || null,
            };
            if (reasoningContent) {
              assistantMsg.reasoning_content = reasoningContent;
            }
            if (sortedToolCalls.length > 0) {
              assistantMsg.tool_calls = sortedToolCalls.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: tc.arguments },
              }));
            }
            rt.messages.push(assistantMsg as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam);

            if (finishReason === 'tool_calls' && sortedToolCalls.length > 0) {
              // Execute MCP tools
              for (const tc of sortedToolCalls) {
                const match = tc.name.match(/^mcp__(.+?)__(.+)$/);
                let toolContent: string;
                if (match) {
                  const [, server, tool] = match;
                  const mcp = rt.mcpClients.get(server);
                  if (mcp) {
                    try {
                      const args = JSON.parse(tc.arguments || '{}');
                      const result = await mcp.client.callTool(
                        { name: tool, arguments: args as Record<string, unknown> },
                        undefined,
                        { timeout: 120_000 },
                      );
                      toolContent = (result as { content: Array<{ type: string; text?: string }> }).content
                        .filter((c: { type: string }) => c.type === 'text')
                        .map((c: { text?: string }) => c.text || '')
                        .join('\n');
                      if (toolContent.length > 50_000) {
                        toolContent = toolContent.slice(0, 50_000) + '\n\n[truncated]';
                      }
                    } catch (err) {
                      toolContent = `Error executing tool: ${err instanceof Error ? err.message : String(err)}`;
                    }
                  } else {
                    toolContent = `Error: MCP server "${server}" not connected`;
                  }
                } else {
                  toolContent = `Error: unknown tool "${tc.name}"`;
                }
                rt.messages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  content: toolContent,
                });
              }
              yield { type: 'activity' };
              // Continue loop for next completion after tool results
              continue turnLoop;
            }

            // No more tool calls — this turn is done
            yield { type: 'result', text: content || null };
            turnDone = true;
          }
        } finally {
          clearInterval(timeoutCheck);
        }
      }
    }

    return {
      push: (message: string) => {
        pending.push(wrapPromptWithContext(message, systemInstructions));
        kick();
      },
      end: () => {
        ended = true;
        kick();
      },
      events: gen(),
      abort: () => {
        aborted = true;
        kick();
      },
    };
  }

  // ── Serve-based query (existing) ──

  private _serveQuery(input: QueryInput): AgentQuery {
    if (input.continuation) {
      this.activeSessionId = input.continuation;
    } else {
      this.activeSessionId = undefined;
    }

    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;

    const systemInstructions = input.systemContext?.instructions;
    pending.push(wrapPromptWithContext(input.prompt, systemInstructions));

    const kick = (): void => {
      waiting?.();
    };

    const self = this;
    const IDLE_TIMEOUT_MS = 90_000;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      let initYielded = false;
      const rt = await ensureSharedRuntime(self.options);
      const { client, stream } = rt;

      while (!aborted) {
        while (pending.length === 0 && !ended && !aborted) {
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }

        if (aborted) return;
        if (pending.length === 0 && ended) return;

        const text = pending.shift()!;
        let sessionId = self.activeSessionId;

        if (!sessionId) {
          const created = await client.session.create();
          if (created.error) {
            throw new Error(`OpenCode: failed to create session: ${JSON.stringify(created.error)}`);
          }
          sessionId = created.data?.id;
          if (!sessionId) throw new Error('OpenCode: failed to create session (no id)');
          self.activeSessionId = sessionId;
        }

        if (!initYielded) {
          yield { type: 'init', continuation: sessionId };
          initYielded = true;
        }

        const promptRes = await client.session.promptAsync({
          path: { id: sessionId },
          body: { parts: [{ type: 'text', text }] },
        });
        if (promptRes.error) {
          self.activeSessionId = undefined;
          throw new Error(`OpenCode promptAsync: ${JSON.stringify(promptRes.error)}`);
        }

        const partTextByMessageId = new Map<string, string>();
        const roleByMessageId = new Map<string, string>();
        let lastEventAt = Date.now();
        let eventTimedOut = false;
        const timeoutCheck = setInterval(() => {
          if (Date.now() - lastEventAt > IDLE_TIMEOUT_MS) {
            log(`OpenCode event timeout (${IDLE_TIMEOUT_MS}ms) — clearing session ${sessionId}`);
            eventTimedOut = true;
            self.activeSessionId = undefined;
            destroySharedRuntime();
            kick();
          }
        }, 5000);

        try {
          turn: while (true) {
            if (aborted) return;
            if (eventTimedOut) {
              throw new Error(`OpenCode event timeout (${IDLE_TIMEOUT_MS}ms)`);
            }

            const { value: ev, done } = await stream.next();
            if (done) {
              throw new Error('OpenCode SSE stream ended unexpectedly');
            }

            if (!ev?.type || ev.type === 'server.connected' || ev.type === 'server.heartbeat') continue;

            lastEventAt = Date.now();
            yield { type: 'activity' };

            switch (ev.type) {
              case 'message.updated': {
                const info = ev.properties.info as { id?: string; role?: string } | undefined;
                if (info?.id && info?.role) {
                  roleByMessageId.set(info.id, info.role);
                }
                break;
              }
              case 'message.part.updated': {
                const part = ev.properties.part as { type?: string; messageID?: string; text?: string } | undefined;
                if (part?.type === 'text' && part.messageID && part.text) {
                  partTextByMessageId.set(part.messageID, part.text);
                }
                break;
              }
              case 'permission.updated': {
                const perm = ev.properties as { id?: string; sessionID?: string };
                if (perm.sessionID === sessionId && perm.id) {
                  try {
                    await client.postSessionIdPermissionsPermissionId({
                      path: { id: sessionId, permissionID: perm.id },
                      body: { response: 'always' },
                    });
                  } catch (err) {
                    log(`Failed to auto-reply permission: ${err instanceof Error ? err.message : String(err)}`);
                  }
                }
                break;
              }
              case 'session.status': {
                const props = ev.properties as {
                  sessionID?: string;
                  status?: { type?: string; attempt?: number; message?: string };
                };
                if (props.sessionID !== sessionId) break;
                const st = props.status;
                if (
                  st?.type === 'retry' &&
                  typeof st.attempt === 'number' &&
                  st.attempt >= SESSION_STATUS_RETRY_ERROR_AFTER &&
                  st.message
                ) {
                  self.activeSessionId = undefined;
                  throw new Error(`OpenCode retry limit (${st.attempt}): ${st.message}`);
                }
                break;
              }
              case 'session.error': {
                const props = ev.properties as { sessionID?: string; error?: unknown };
                if (props.sessionID === sessionId || props.sessionID === undefined) {
                  self.activeSessionId = undefined;
                  throw new Error(sessionErrorMessage(props));
                }
                break;
              }
              case 'session.idle': {
                const sid = (ev.properties as { sessionID?: string }).sessionID;
                if (sid === sessionId) {
                  break turn;
                }
                break;
              }
              default:
                break;
            }
          }
        } finally {
          clearInterval(timeoutCheck);
        }

        let resultText = '';
        for (const [msgId, role] of roleByMessageId) {
          if (role === 'assistant') {
            resultText = partTextByMessageId.get(msgId) ?? resultText;
          }
        }
        yield { type: 'result', text: resultText || null };
      }
    }

    return {
      push: (message: string) => {
        pending.push(wrapPromptWithContext(message, systemInstructions));
        kick();
      },
      end: () => {
        ended = true;
        kick();
      },
      events: gen(),
      abort: () => {
        aborted = true;
        this.activeSessionId = undefined;
        kick();
        destroySharedRuntime();
      },
    };
  }
}

registerProvider('opencode', (opts) => new OpenCodeProvider(opts));
