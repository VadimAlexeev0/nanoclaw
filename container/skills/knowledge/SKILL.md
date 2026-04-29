---
name: knowledge
description: Maintain Vadim's personal Obsidian wiki and mnemon memory graph. Use for ingesting sources, recording durable facts, updating wiki pages, and answering from persistent knowledge.
---

# Personal Knowledge System

You maintain one personal knowledge base for Vadim.

## Storage

- Obsidian vault: `/workspace/knowledge/obsidian`
- Inbox: `Inbox/`
- Raw sources: `Sources/`
- Synthesized wiki: `Wiki/`
- Mnemon memory graph: use `knowledge_remember`

## Rules

- Store durable atomic facts in mnemon with `knowledge_remember`.
- Write human-readable synthesis to Obsidian markdown under `Wiki/`.
- Keep raw source files under `Sources/`; do not rewrite the source after intake.
- For ingest, process one source at a time. Finish facts, links, wiki updates, index, and log for that source before starting the next.
- Prefer Obsidian links like `[[Wiki/Entities/Name]]`.
- Use YAML frontmatter for generated wiki pages.

## Wiki Layout

- `Wiki/Home.md`
- `Wiki/Index.md`
- `Wiki/Log.md`
- `Wiki/Entities/`
- `Wiki/Concepts/`
- `Wiki/Timelines/`
- `Wiki/Questions/`

## Ingest Checklist

1. Read the source fully.
2. Extract self-contained facts and store them with `knowledge_remember`.
3. Update or create relevant entity, concept, timeline, and question pages.
4. Update `Wiki/Index.md`.
5. Append `Wiki/Log.md` with what changed and source citation.

## Recall

Relevant mnemon memories are injected automatically before each response. Treat them as background context and cite them only when useful.
