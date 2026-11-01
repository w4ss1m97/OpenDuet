# Duet C1 — Cockpit Projects in OpenDuet (design)

Phase C1 of rewriting Cockpit (~/Desktop/runner-dashboard, Python) in TypeScript inside OpenDuet, so one Duet
app (Tauri DMG) holds both. The Python Cockpit keeps running until parity (C4). Architect-reviewed 2026-11-01.

## Goal
Projects section: one card per project in `~/.claude/cockpit-projects.txt` (notes State + Exact next step,
branch, dirty files, worktrees, PRs, CI, live sessions) plus the attention inbox. Read-only on projects.

## Decisions
- **D1 separate listener.** `Bun.serve({hostname: "127.0.0.1", port: OPENDUET_COCKPIT_PORT ?? 3002})` with its own
  Hono app; ignores `OPENBOT_HOST` (which includes the LAN IP 192.168.1.106). Never mounted on the main app
  (main app answers 404). Reason: the app proxy forwards /api from 127.0.0.1, so remote-IP checks on :3001 lie.
- **D2 guards.** Host must be `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding); foreign `Origin` → 403;
  allowlist = `appOrigins(config)` + `tauri://localhost`; ACAO only for an allowed origin, never `*`; GET only
  (else 405); `server.requestIP` must be loopback.
- **D3 no DB tables.** Machine data, computed from disk + gh; owner scoping does not apply.
- **D4 compute on request.** In-memory TTL cache (git 15 s, gh PRs/runs 60 s, merged branches 300 s), shared
  in-flight calls, last good value on failure. UI refetches every 30 s.
- **D5 command runner.** Only `git` and `gh`, `Bun.spawn(argv)`, no shell. Timeouts 10 s / 25 s then SIGKILL;
  stdout cap 1 MiB; stderr dropped; fixed env (PATH, HOME, GIT_TERMINAL_PROMPT=0, GIT_OPTIONAL_LOCKS=0,
  GH_PROMPT_DISABLED=1, NO_COLOR=1, LC_ALL=C). Every git call starts with
  `--no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c protocol.allow=never -C <path>`.
  gh: slug `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`, only `pr list --repo S …` and `api repos/S/actions/runs?per_page=30`.
- **D6 paths.** Line `name|path|test` (test ignored). Name `^[\w .-]{1,40}$`; path `~`-expanded, absolute,
  NUL-free, realpath under realpath(home), a dir with `.git`; duplicates dropped. Worktree paths re-checked.
  Notes: lstat regular file, realpath inside the project, ≤ 64 KiB. Sessions: `~/.claude/sessions/*.json` only
  (never `*.key`), keep {pid, sessionId, cwd, name, status, updatedAt}, pid alive via `process.kill(pid, 0)`.
- **D7 actions.** Copy resume prompt (client side) in C1. Open in Terminal deferred to C1b: no POST in C1.
- **D8 idle session:** live, cwd in project or worktree, status ≠ busy, older than sessionIdleHours (6).
- **D9** separate from `projects.yaml`; do not touch `items/project-scanner.ts` / `local-runner.ts` (shell strings).
- Start only when `process.platform === "darwin"` and `OPENDUET_COCKPIT=1`.

## Batches (branch feat/duet-c1-cockpit-projects, all under openbot/server/src/openduet/cockpit/)
- **B1** `run.ts` (runAllowed, injectable spawn), `projects-file.ts` (loadCockpitProjects, safeSubpath).
  Tests `openduet-cockpit-paths`, `openduet-cockpit-run`: bad lines skipped; symlink out of home skipped;
  notes symlink out → null; unknown tool / bad slug refused before spawn; git flags first; timeout kill → null;
  >1 MiB → null; non-zero exit → null; argv array.
- **B2** `collect.ts` (ports of server.py:523-697, notes.nextStep, sections ≤ 4000 chars), `attention.ts`
  (server.py:700-741, thresholds dirtyHours 24 / notesLagDays 2 / sessionIdleHours 6), `types.ts`, `cache.ts`.
  Tests `openduet-cockpit-collect`, `-attention` (one per rule, sort high → low), `-cache`.
- **B3** `server.ts` (createCockpitApp, startCockpitServer); `GET /api/cockpit/projects` →
  {projects, attention, names, generatedAt}; `GET /api/cockpit/projects/:name` (404 if unknown); index.ts gate.
  Tests `openduet-cockpit-routes`: LAN Host 403; foreign Origin 403 no ACAO; allowed Origin echoed; POST 405;
  unknown 404; binds 127.0.0.1 only; main app 404 on /api/cockpit/projects.
- **B4 UI** `openbot/app/src/lib/cockpit/{queries,resume-prompt}.ts`, routes
  `_authed/_app/cockpit.projects.tsx` + `cockpit.projects.$name.tsx` (routeTree regenerated, not hand-edited),
  menu entry in `components/shell/menu-sheet.tsx`. Test `app/tests/cockpit-resume-prompt.test.ts`.
- Verify: `bun test tests/openduet-cockpit` then `bun run typecheck` (server and openbot/).

## Open questions
1. `OPENBOT_HOST` includes the LAN IP: the main app is reachable from the LAN with no auth today. A phone-only
   route set or a token in a later phase?
2. Port 3002 (free on 2026-11-01): check it against the desktop's own port allocation (desktop/src-tauri/src/env.rs).
3. One project list later? `cockpit-projects.txt` vs tenant `projects.yaml` kept separate in C1.

## Out of scope
Open in Terminal (C1b), Usage (C2), CI/runners/Machine (C3), Quality, reminders, notifications (C4), Telegram,
DMG signing/notarization.
