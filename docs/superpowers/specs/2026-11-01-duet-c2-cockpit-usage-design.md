# Duet C2 — Cockpit Usage (design, architect-reviewed 2026-11-01)

Claude Code tokens and API-equivalent cost from `~/.claude/projects` transcripts (1.3 GB JSONL), per day/hour,
project, session, model, agent; budgets with attention items; advisor tips; CSV export. Port of Cockpit's
usage.py / usage.js / advisor.py, inside the C1 cockpit listener (127.0.0.1:3002, async fs only).

## Decisions
1. **Storage = JSON store** in memory, saved atomically (temp + rename) to
   `~/.config/openduet/cockpit/usage-store.json` (file 0600, dir 0700). The index is small (Cockpit's usage.db is
   344 KB). No Postgres (no owner on the cockpit listener, C1 D3), no bun:sqlite (synchronous).
2. **Project resolved at query time** from the session's dir + first cwd against the current C1 project list
   (cwd = project/worktree path or under it → dir encoding → port of server.py `project_label`). Editing
   `cockpit-projects.txt` relabels history. Prices also applied at query time.
3. **Dedupe** like usage.py:221-232: a repeated `message.id` in one file adds only output growth, 0 requests.
   The last 64 `[id, output]` pairs per file are persisted, so a restart never double-counts.
4. **Background poller** (single-flight, every 30 s, started by `startCockpitServer`); GET never waits and returns
   `status {backfilling, filesDone, filesTotal, skippedLines, lastError}`. Backfill newest file first, save every
   25 files, `setImmediate` between files. 1 MiB reads from the offset; offset only past a full `\n`; lines over
   16 MiB skipped; shrunk file or new inode → offset = size, never recount; deleted file keeps its rows.
5. **Europe/Paris** for days, hours and weeks (Monday 00:00), injectable tz for tests.
6. **Config** `~/.config/openduet/cockpit/usage-config.json`, hand-edited, zod-validated, re-read on mtime change:
   prices (longest-prefix model key, user table replaces defaults), fallbackPrice (warning), budgets, budgetPercent,
   advisor thresholds + cheaperMain/cheaperSearch. Invalid → defaults + `configError`.
7. **Advisor** rules opus-short, big-context, opus-search (advisor.py:30-75), pure; idle sessions and stale notes
   stay in attention.ts. Dismiss = localStorage 7 days (server stays GET-only).
8. **Charts** hand-written SVG, no library. **CSV** built on the server: every string quoted, `"` doubled, cells
   starting with = + - @ tab CR prefixed with `'`.

## Types (cockpit/usage-types.ts)
Tok {input, cw5, cw1h, cr, output, requests}; UsageRow = Tok + {day, hour, session, model, agent, agentId};
FileState {offset, size, ino, tail}; SessionMeta {id, name, dir, cwd, first, last};
UsageStore {version 1, files, rows (key day|hour|session|model|agent|agentId), sessions, subagents};
Price = [in, 5m write, 1h write, cache read, out] $/MTok; UsageConfig; Budget {scope, unit usd|tokens, limit}.

## Batches (tests `openbot/server/tests/openduet-cockpit-usage-*.test.ts`, red first)
- **B1 parse + prices** usage-parse.ts, usage-prices.ts: 1h/5m cache writes; fallback to
  cache_creation_input_tokens; skip `<synthetic>`; reject negative/string counts; Paris DST day/hour; subagent
  path; opus-4-5-2025… uses opus-4-5; unknown → fallback + known=false; invalid config → defaults + configError;
  user prices replace table.
- **B2 store + ingest** usage-store.ts, usage-ingest.ts: append-only re-read; repeated id adds output growth;
  dedupe survives restart; partial last line waits; truncated file not recounted; oversized line skipped;
  concurrent runOnce share one pass; symlink ignored; subagent meta sets agent; custom-title names session.
- **B3 queries, budgets, advisor, CSV** usage-query.ts, usage-advisor.ts, csv.ts: worktree cwd → project; dir
  fallback; unmapped label; relabel on list change; cost follows price change; unknownModels; week starts Monday
  Paris (Sunday 23:30Z → next week); 80% medium / 100% high; tokens unit excludes cache reads; limit 0 ignored;
  advisor rules + maxPerKind; CSV formula prefix, numbers untouched, quotes doubled.
- **B4 routes + wiring** server.ts GET `/api/cockpit/usage?from&to` (≤ 400 days, default 30),
  `/usage/sessions/:id`, `/usage/budgets`, `/usage/advisor`, `/usage/export.csv?view=days|sessions|models|agents`
  (attachment). Budget attention merged into the projects snapshot (`extraAttention`). Poller in
  startCockpitServer (unref). Tests: bad date 400; span 400; unknown session 404; POST 405; csv headers; csv
  sanitized; budget item in snapshot; route answers while backfill pending.
- **B5 UI** lib/cockpit/usage.ts (pivots), components/cockpit/usage-charts.tsx, usage-tables.tsx, routes
  cockpit.usage.tsx, cockpit.usage_.project.$name.tsx, cockpit.usage_.session.$id.tsx, nav link. Banners for
  configError, unknownModels, backfill progress, "API-equivalent cost". Check CSV download in Duet.app
  (fallback: copy to clipboard).
- **B6 history import (one-time CLI)** `openbot/server/scripts/import-cockpit-usage.ts`: reads Cockpit's
  usage.db read-only (bun:sqlite, outside the server), rows before the oldest transcript become synthetic
  per-project sessions, never touching `files`.

## Decisions by Wassim (defaults accepted 2026-11-01 unless changed)
Q1 import Cockpit history since 2026-07-17 (B6) · Q2 config hand-edited, no settings POST in C2 ·
Q3 Europe/Paris time.

## Out of scope
Settings form, Telegram, CI/runners/Machine (C3), Quality and reminders (C4).
