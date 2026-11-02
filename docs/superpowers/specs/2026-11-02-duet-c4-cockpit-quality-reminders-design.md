# Duet C4 — Cockpit Quality & security, reminders, notifications (design, architect-reviewed 2026-11-02)

Port of Cockpit quality.py / reminders.py / notify.py / quality.js / extras.js inside the C1 listener
(127.0.0.1:3002, async fs only, argv allowlist, no DB tables, C1 D3). Read-only on projects, no Claude tokens.

## Decisions
1. **Programs (all in `cockpit/run.ts` `allowed()`, per-tool timeout table: git 10 s, gh 25 s, npm 120 s, osascript 10 s).**
   - gh api, `isSlug` + fixed query strings only: `repos/S/actions/runs?per_page=100&created=%3E%3DYYYY-MM-DD`
     (date regex), `repos/S/actions/runs/N/jobs`, `repos/S/actions/runs/N/attempts/1/jobs` (N `^\d{1,20}$`, ≤ 4 calls
     per scan, for flaky jobs), `repos/S/dependabot/alerts?state=open&per_page=100`,
     `repos/S/code-scanning/alerts?state=open&per_page=100`,
     `repos/S/secret-scanning/alerts?state=open&per_page=100&hide_secret=true` (parser keeps only counts, raw text never
     kept), `repos/S/branches/B/protection` (B `^[A-Za-z0-9._-]{1,100}$`, no leading dash, else skipped), `repos/S`
     (allow_auto_merge). New `runGhApi(path)` → `{ok:true,json}|{ok:false,status:number|null}`; stderr read ≤ 4 KiB, only
     `/HTTP (\d{3})/` kept. 403 → "not available on this plan", 404 → "not set up".
   - **Job-log download dropped** (big, can hold secrets, needs `--allow-escape-sequences`). Coverage = enforced floor
     (`--cov-fail-under` in workflows, `fail_under` in pyproject) + measured value from a report on disk
     (`coverage/coverage-summary.json`, `coverage.xml`, ≤ 5 MiB each), else "not reported".
   - npm, only when `package.json` exists (audit also needs `package-lock.json`):
     `["npm","audit"|"outdated","--json","--ignore-scripts","--registry=https://registry.npmjs.org/","--prefix",<abs>]`.
     `--prefix` replaces cwd (runner stays argv-only); pinned registry so a project `.npmrc` cannot redirect or leak tokens
     (no private registries in Wassim's projects, checked 2026-11-02). Exit 0 and 1 both OK. Env adds
     `npm_config_update_notifier=false`, `npm_config_fund=false`. Stdout cap 8 MiB. Config `quality.npm` (default true).
   - **uv dropped** (`--python <venv>` runs a project binary): "not scanned (Python: see Dependabot)".
   - **gitleaks cut** (reads ignored files, output carries redacted lines): tracked-file scan + GitHub secret scanning.
   - New git shapes (after `-C <dir>`): `ls-files -z`; `ls-files -z --others --exclude-standard` (names only, for
     .gitignore gaps); `log --since=30.days --name-only --format= --no-renames --no-merges` (churn, stdout 4 MiB);
     `log -1 --format=%ct`; `for-each-ref --format=%(refname:short)%09%(committerdate:unix) refs/heads`. Reused:
     `worktree list --porcelain`, `rev-parse --abbrev-ref HEAD`.
2. **One secret list** in `secrets.ts`: `SECRET_PATTERNS: {type, severity, re}[]` = union of the existing list and Python's
   (private key, AWS, GCP SA key id, GCP API key medium, Stripe live, GitHub, Telegram, Slack, Anthropic, generic sk-),
   first match per line wins. `containsSecret` derived from it (explorer as strict or stricter).
   `findSecretLines(text) → {line,type,severity}[]`, never the match text. Lines over 2,000 chars skipped.
   Tracked files `isNeverRead` refuses → `{file, line:0, type:"tracked sensitive file", severity:"high"}`, never opened.
   `.env.example|sample|template|dist` → no finding, still not read.
3. **File reads** on the working tree via async fs: `lstat` (skip symlinks/non-files), realpath under the project root,
   open with O_NOFOLLOW. Limits 1 MiB/file, 4,000 files, 64 MiB/scan. NUL in first 4 KiB → binary, skipped.
   `setImmediate` every 25 files. Health = Python minus `longFunctions` (cut).
4. **Scheduling:** `createQualityService().start()` (unref): first check 60 s after start, then every 15 min scans
   projects with `scannedAt < now − scanHours·3600`. Single-flight, one project at a time; a failure goes to
   `status.lastError`, others still run. GET never waits. "Scan now" queues (deduped), answers 202.
5. **Score/suggestions/high findings** = exact port of quality.py `score`, `grade`, `suggestions`, `high_findings`
   (30/20/25/15/10, renormalised over live categories). Suggestion `key` = sha256(project+id)[0:16] hex.
   High findings → attention items (high, link `/cockpit/quality/<name>`) merged into `extraAttention` with usage.
6. **Writes = one pattern:** body-less simple POST, arguments in query params, matched against a `WRITES` regex list in
   the middleware (explain + C3 runner control + C4). Allowed Origin required (missing → 403), Content-Length ≠ 0 or any
   Transfer-Encoding → 400, repeated param → 400. No JSON bodies, no CORS preflight: OPTIONS stays 405 without
   ACAO/Allow-Methods. Global limit 30 writes/min → 429 + Retry-After (the runner control keeps its own limits too).
   Query-string payloads are fine here: the listener has no access log.
7. **Notifications:** argv exactly `["/usr/bin/osascript","-e","on run argv","-e","display notification (item 2 of argv)
   with title (item 1 of argv)","-e","end run","--",title,body]` (checked 2026-11-02: `--` honoured, `-a` arrives as
   data). No interpolation. Control chars stripped; title ≤ 80, body ≤ 240. **Off by default.** Quiet hours 22:00–08:00
   Europe/Paris (held, sent after). ≤ 6/hour, extras wait. Never twice: `sent["id|due"]`, pruned after 30 days.
   "Test" sends even when disabled, 1/min.
8. **Automatic reminders** (every 2 min, from the cached snapshot + usage budgets + quality summary). Keys
   `ci:<p>:<wid>` (after ciRedHours), `pr:<p>:<n>` (green, not draft, mergeState not DIRTY/BEHIND, after prWaitHours from
   first seen), `dirty:<p>` (after dirtyDays), `budget:<scope>:<80|100>`, `quality:<p>:<key>` (immediate). Done = ack
   until the condition clears; snooze = hidden until the time; delete → 400. A key clears only on a complete snapshot
   (no `error`, prs/runs not null): a gh outage never re-arms acks.
9. **Ids:** user `u` + 15 hex (crypto), automatic `a` + sha256(key)[0:15]; every id `^[ua][0-9a-f]{15}$`.

## Persistence (`~/.config/openduet/cockpit/`, 0600 files, 0700 dir, temp+rename, zod on load, invalid → empty + error)
- `quality-scans.json` {version 1, scans{project: QualityResult}, history{project: [{day, score, grade, categories}]}
  (one row per Paris day, last wins, 90 days), dismissed{key: until}}.
- `reminders.json` {version 1, items[{id, text, project, due, repeat none|daily|weekly, created}]} (max 200 → 409).
- `reminder-state.json` {version 1, first{}, ack{}, snooze{}, sent{}}.
- `cockpit-config.json`, hand-edited, re-read on mtime/size change: quality{enabled true, scanHours 24 (1–168),
  lookbackDays 30 (7–90), bigFileLines 800, staleBranchDays 30, npm true}; autoReminders{ciRedHours 1, prWaitHours 24,
  dirtyDays 2, budgetPercent 80}; notifications{enabled false, quietEnabled true, quietStart "22:00", quietEnd "08:00",
  maxPerHour 6}. Invalid → defaults + `configError`.
- One async mutex per file.

## Routes
GET `/api/cockpit/quality` (summary + status + configError) · GET `/api/cockpit/quality/:name` (result + 30-day trend +
suggestions with dismissedUntil; 404 unknown) · GET `/api/cockpit/reminders` ({items, dueCount, notifications{enabled,
quietNow, lastSentAt}}).
POST `/api/cockpit/quality/scan?project=<name>|all` (202; `all` ≤ 1 per 5 min) ·
POST `/api/cockpit/quality/:name/dismiss?key=<16hex>` (30 days) ·
POST `/api/cockpit/reminders?text=&due=<epoch s>&project=&repeat=` (text NFC, trimmed, 1–200, no \p{Cc}; due in
[now−1 d, now+366 d]; project '' or a C1 name) · POST `/api/cockpit/reminders/:id/done|snooze|delete` (`until` in
(now, now+30 d], default +1 h) · POST `/api/cockpit/notifications/test`.

## Batches (red first; server tests `openbot/server/tests/openduet-cockpit-{quality,reminders}-*.test.ts`)
- **B1 allowlist + secrets** run.ts, secrets.ts → `-quality-run`, `-quality-secrets`: each gh shape accepted;
  per_page≠100, extra query, `..` slug, branch with `/` or leading `-`, job id with letters refused; npm without pinned
  registry / `--ignore-scripts` / absolute prefix refused; npm exit 1 → stdout; uv and gitleaks refused; osascript with
  another script refused; stderr gives only 403/404; secret-scanning parser returns counts only (fixture with `"secret"`
  → serialised output has none); findSecretLines line numbers, no match text; first pattern per line; explorer
  `containsSecret` cases still true; `.env.example` no finding, `.env` "tracked sensitive file".
- **B2 scanners as pure parsers** quality-parse.ts + quality-files.ts → `-quality-parse`, `-quality-files`: flaky (fail +
  success same sha; attempt 2); dynamic runs ignored; npm "no result" error; symlink skipped; escape via symlinked dir
  skipped; >1 MiB skipped; binary skipped; 4,000-file cap; isNeverRead never opened (spy on open).
- **B3 score, suggestions, store, scheduler** quality-score.ts, quality-store.ts, quality-service.ts → `-quality-score`,
  `-quality-store`, `-quality-service`: grade bounds 90/80/70/60; renormalisation; each Python deduction; suggestion
  order + stable key; high-finding rules; one history row per Paris day; dismissal 30 days; invalid store → empty +
  error; due after scanHours; single-flight; a failing project does not stop the queue; GET answers during a scan.
- **B4 reminders + notify** reminders.ts, notify.ts, cockpit-config.ts → `-reminders-store`, `-reminders-auto`,
  `-reminders-notify`: add validation (empty, 201 chars, control char, bad repeat, due out of range, unknown project,
  201st item); done on repeat jumps past now; snooze; delete auto → error; ci after 1 h not before; pr from first seen;
  ack held while active, cleared on a complete snapshot, kept when prs=null; budget 80/100; quiet across midnight;
  never twice across a restart; 7th in the hour waits; disabled → nothing except the test; mutex keeps add + tick.
- **B5 routes + guard** server.ts (WRITES list), wiring in startCockpitServer → `-quality-routes`, `-reminders-routes`:
  write without/foreign Origin 403, body 400, Transfer-Encoding 400; OPTIONS 405 no ACAO; PUT/DELETE 405; 31st write/min
  429; scan 202 + dedup; all twice in 5 min 429; bad key/id 400; unknown 404; quality attention merged with usage;
  explain + runner POST tests unchanged.
- **B6 UI** lib/cockpit/quality.ts, lib/cockpit/review-prompt.ts (copies `/review-sec` or `/code-review` with findings
  as file:line/type only), components/cockpit/quality-parts.tsx; routes `cockpit.quality.tsx`,
  `cockpit.quality_.$name.tsx`, `cockpit.reminders.tsx`; due strip on `cockpit.projects.tsx`; menu entries "Quality",
  "Reminders (n)"; routeTree regenerated. App tests `cockpit-quality.test.ts`, `cockpit-quality-prompt.test.ts`,
  `cockpit-reminders.test.ts`.

## Defaults taken (2026-11-02)
Notifications off by default (enable in cockpit-config.json) · npm registry pinned · osascript `--` kept.

## Cut (C4b)
gitleaks, uv/Python outdated, CI-log coverage, longFunctions, Telegram, settings form, Gradle.
