# Duet C3 — Cockpit CI + Machine (design, architect-reviewed 2026-11-02)

Port of runner-dashboard server.py:184-357 + 783-823 and app.js pageCI/pageMachine into the C1 listener
(127.0.0.1:3002). Same guards (C1 D2), no DB (C1 D3), TTL cache (C1 D4), async fs only (no `*Sync(`).

## Decisions
- **D1 Routes (GET).** `/api/cockpit/ci` → {repos:[{repo, projects[], runners[], runs[], jobs[], error}],
  local:[NativeRunner], containers:[runner containers], generatedAt}. `/api/cockpit/machine` → {cores, load[3],
  memTotalGB, memFreePercent|null, diskFreeGB, diskTotalGB, thresholds, docker:{running:false}|{running:true,
  cpus, memGB, containers[], disk{<type>:{size, reclaimable}}}|null}.
- **D2 Repos** = union of C1 snapshot `repo` (cached) + `.runner` gitHubUrl slugs (github.com only, isSlug). No config.
  ONE TtlCache instance shared by CockpitService and the new CI/machine services (passed from startCockpitServer).
  `parseRuns` grows additive `started` (run_started_at|null) + `attempt` (run_attempt ?? 1); key stays `runs:<slug>`.
- **D3 Machine without spawn:** cores/load/memTotal from `os`; disk `fs.promises.statfs("/")`; free % only via
  `sysctl -n kern.memorystatus_level` (0-100, else null).
- **D4 Runner discovery.** `readdir(realpath(home))`, keep names `^actions-runner[\w.-]*$` BEFORE any lstat; lstat
  dir, not symlink. Read only `.runner` (regular, ≤ 16 KiB, strip BOM, zod: agentName `^[\w.-]{1,64}$`,
  gitHubUrl) and `.service` (regular, ≤ 1 KiB). Never open `.env`, `.credentials*`, `.path`, `_diag`.
  No `.runner` → skipped (actions-runner-books).
- **D5 Process match.** `ps comm=` gives the binary path without arguments (other processes' argv never loaded).
  Listener = row whose comm === `<dir>/bin/Runner.Listener` (dir realpath); working = a child whose comm ends
  `/bin/Runner.Worker`; cpu/ram = tree sum (tree_usage port). comm never leaves the parser.
- **D6 Response hygiene.** NativeRunner = {name, dir:"~/<basename>", repo slug, paused, working, serviceLoaded
  (bool from launchctl list label match), nice, cpuPercent, ramMB, workGB|null}. No pid, absolute path, serverUrl,
  pool, or env. Containers = {name, runnerName|null, status, cpu, mem, paused}. Non-runner containers only while running.
- **D7 Slow facts in the background.** `du` (600 s) and `docker system df` (300 s) refresh fire-and-forget,
  single-flight. The GET returns the last value (null at first) and never awaits them.
- **D8 TTLs.** os/statfs/sysctl/ps 10 s; launchctl list 30 s; docker info/ps/inspect/stats 30 s; gh runners + runs
  60 s; jobs 60 s, only for queued/in_progress runs, max 5 per repo and 10 per snapshot. gh is only called while a
  page reads (cache, no poller).
- **D9 Thresholds** constants {loadPerCoreWarn 1.0, ramFreeWarnPercent 20, diskFreeWarnGB 50}. One attention item
  via extraAttention: `disk-low` (high) from statfs. Runner-offline attention deferred to C4.
- **D10 Pause/resume (in C3).** `POST /api/cockpit/runners/:name/{pause|resume}`, optional `?force=1` (exact; other
  or repeated query → 400). Same guard as explain: Origin required + allowlisted (app origins + `tauri://localhost`),
  no body (400), OPTIONS 405, other POST 405. The name must be discovered now (fresh discovery, not cache). Pause when
  GitHub busy (cache ≤ 60 s) or a local Worker child exists (fresh ps) → 409 unless force. Native plist = `.service`
  text, trimmed, must match `^<realHome>/Library/LaunchAgents/actions\.runner\.[\w.-]+\.<agentName>\.plist$`, lstat
  regular file, uid === process.getuid(), realpath unchanged. Never run svc.sh. Docker: container whose
  RUNNER_NAME === name, addressed by full 64-hex Id. Single-flight per runner + one control at a time (429),
  ≤ 30/hour (429 + Retry-After). Afterwards invalidate machine/ci keys. 200 {state}, 404, 409, 429, 502.
  Pause = `launchctl unload` like svc.sh: it does not survive a re-login (said in the UI).
- **D11 PATH.** `fixedEnv` appends `/usr/local/bin:/opt/homebrew/bin` when missing (Duet.app started from Finder).

## Allowlist additions (run.ts, exact argv; gh/git unchanged)
- gh: `api repos/S/actions/runners?per_page=100`; `api repos/S/actions/runs/<1-20 digits>/jobs?per_page=50`.
- `sysctl -n kern.memorystatus_level` · `ps -axo pid=,ppid=,nice=,%cpu=,rss=,comm=` · `launchctl list`.
- `du -sk P`: P absolute, matches `^/(?:[^/\0]+/)+actions-runner[\w.-]*/_work$`, no `..` segment.
- `launchctl unload P` · `launchctl load -w P`: P matches `^/Users/[^/]+/Library/LaunchAgents/actions\.runner\.[\w.-]+\.plist$`, no `..`.
- docker: `info --format {{.NCPU}}|{{.MemTotal}}`; `ps -aq --no-trunc`; `stats --no-stream --no-trunc --format
  {{.ID}}|{{.CPUPerc}}|{{.MemUsage}}`; `system df --format {{.Type}}|{{.Size}}|{{.Reclaimable}}`;
  `inspect --format <INSPECT_TEMPLATE> ID…` (1-100 ids, each `^[0-9a-f]{64}$`), with
  `INSPECT_TEMPLATE = {{.Id}}|{{.Name}}|{{.State.Status}}|{{range .Config.Env}}{{if eq (index (split . "=") 0) "RUNNER_NAME"}}{{.}}{{end}}{{end}}`
  (checked on this Mac 2026-11-02: prints `RUNNER_NAME=…` or nothing; POSTGRES_PASSWORD never leaves docker);
  `stop ID` / `start ID` (64-hex).
- Per-tool timeouts: git 10 s, gh 25, sysctl 3, ps 5, launchctl list 5 / load-unload 40, du 60, docker 10
  (stats 20, system df 30, stop/start 60). Caps: ps 2 MiB, others 1 MiB.

## Batches (red first; tests under openbot/server/tests/)
- **B1 runner** run.ts + `openduet-cockpit-run.test.ts` (extend) and `openduet-cockpit-ci-run.test.ts`:
  ps `command=` refused, `comm=` ok; `du` relative / `..` / other dir refused; launchctl other subcommand,
  plist outside LaunchAgents, or `bootout` refused; docker inspect without the exact template, `inspect ID`
  bare, short id, or exec/rm/run refused; jobs non-digit id refused; runners per_page≠100 refused;
  timeout table picked (fake spawn sees kill at the tool's timeout); C1/C1c tests stay green.
- **B2 parsers + collectors** `cockpit/machine.ts`, `cockpit/ci.ts` (pure parsers + services with injected deps),
  collect.ts parseRuns extension. Tests `openduet-cockpit-machine-parse.test.ts`: ps with spaces in comm; tree sum;
  Worker child → working; sysctl junk → null; docker stats/df/inspect lines; a POSTGRES_PASSWORD fixture never in
  output; stopped non-runner dropped. `openduet-cockpit-ci-parse.test.ts`: BOM `.runner`; bad JSON / >16 KiB /
  symlinked dir skipped; non-matching home entries never lstat'd (spy); repo union dedups; jobs only for
  active runs, capped 5/10; `du` not awaited; response has no `/Users/`, no pid (JSON string scan).
- **B3 routes + control** server.ts, `cockpit/runner-control.ts`, cache.ts `invalidate(prefix)`. Tests
  `openduet-cockpit-ci-routes.test.ts` + `openduet-cockpit-machine-routes.test.ts`: GETs 200 with shapes; LAN Host
  403; POST without / foreign Origin 403 no ACAO; body 400; `?force=yes` 400; unknown runner 404; busy 409, force
  200; `.service` outside LaunchAgents / symlink / other uid → 502, no spawn; docker by Id only;
  2 concurrent → 1 spawn; 31st per hour 429; disk-low attention appears in /projects.
- **B4 UI** `openbot/app/src/lib/cockpit/{ci,machine}.ts`, routes `_authed/_app/cockpit.ci.tsx`,
  `cockpit.machine.tsx` (routeTree regenerated), menu-sheet entries; gauges, runner rows, queued jobs, runs table;
  pause/resume button with confirm on 409; refetch 30 s. Test `app/tests/cockpit-machine-gauges.test.ts`.
- Verify: `bun test tests/openduet-cockpit` then `bun run typecheck` (server and openbot/).

## Defaults taken (2026-11-02)
gh TTL 60 s (only while a page reads) · launchctl load/unload kept (matches svc.sh) · pause/resume in C3.

## Out of scope
Pause-all, runner registration/removal, `docker system prune`, runner-offline reminders (C4), Linux.
