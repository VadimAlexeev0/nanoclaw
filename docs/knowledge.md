# Personal Knowledge System

NanoClaw can maintain one personal Obsidian + mnemon knowledge base for Vadim.

## Paths

- Obsidian vault: `/srv/obsidian`
- Mnemon data: `/srv/mnemon`
- Backups: `/srv/backups`

Create the mnemon directory once if it does not exist:

```bash
sudo mkdir -p /srv/mnemon
sudo chown -R "$USER:$USER" /srv/mnemon /srv/backups
```

Initialize the vault layout:

```bash
pnpm exec tsx scripts/knowledge/init.ts
```

## Obsidian Headless

The vault is expected to be configured with Obsidian Headless:

```bash
ob sync-status --path /srv/obsidian
ob sync --path /srv/obsidian
```

Recommended configuration:

```bash
ob sync-config --path /srv/obsidian --mode bidirectional --conflict-strategy conflict
```

## Mnemon

Install mnemon on the host:

```bash
scripts/knowledge/install-mnemon.sh
```

If neither Homebrew nor Go is installed, install Go 1.24+ or Homebrew first.

NanoClaw containers mount `/srv/mnemon` at `/workspace/knowledge/mnemon` and use the `default` store.

## Vault Layout

```text
Inbox/
  Clips/
  Imports/
  Attachments/
  Processed/
  Failed/
Sources/
  Articles/
  Transcripts/
  Notes/
  PDFs/
  Media/
Wiki/
  Home.md
  Index.md
  Log.md
  Entities/
  Concepts/
  Timelines/
  Questions/
System/
  NanoClaw.md
  Ingest Queue.md
```

## Runtime Behavior

Before each model invocation, the agent runner calls:

```bash
mnemon --data-dir /workspace/knowledge/mnemon --store default recall "<message>" --limit 8
```

Results are injected as a system reminder before the prompt.

Agents can explicitly write durable facts with the `knowledge_remember` MCP tool and write synthesized Obsidian notes with `knowledge_write_note`.

## Continuous Sync and Ingest

Install user services:

```bash
pnpm exec tsx scripts/knowledge/install-services.ts
```

This creates:

- `nanoclaw-obsidian-sync.service` — runs `ob sync --path /srv/obsidian --continuous`
- `nanoclaw-knowledge-watch.service` — watches `Inbox/` and queues NanoClaw ingest tasks
- `nanoclaw-knowledge-backup.timer` — runs daily backups

Check status:

```bash
systemctl --user status nanoclaw-obsidian-sync.service
systemctl --user status nanoclaw-knowledge-watch.service
systemctl --user list-timers nanoclaw-knowledge-backup.timer
```

The watcher queues `.md`, `.markdown`, and `.txt` files dropped into `Inbox/Clips` or `Inbox/Imports`, writes an entry to `System/Ingest Queue.md`, then moves the source to `Inbox/Processed`.

## Backups

```bash
scripts/knowledge/backup.sh
```
