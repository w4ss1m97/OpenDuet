# Duet C1c — Project explorer (design, architect-reviewed 2026-11-01)

Follows C1 (Cockpit Projects, PR #8). One page per cockpit project at `/cockpit/projects/$name/explore`:
facts computed in code (zero tokens) + an LLM explanation generated on demand, cached per HEAD.

## Corrections found in review
1. C1 runner `allowed()` (cockpit/run.ts:52-62) accepts any git subcommand: B1 adds a subcommand + argv-shape
   allowlist (C1's rev-parse, rev-list, status, symbolic-ref, worktree, log calls + the new ones below).
2. index.ts starts the cockpit before `listComplete` exists: move the cockpit block below it, inject
   `explain: { complete: listComplete }`.
3. Secret patterns are defined here in `cockpit/secrets.ts`; C4 reuses them.
4. Diagram = structured JSON drawn as SVG by our code (labels are React text). No Mermaid, no innerHTML.
5. Route file `cockpit.projects_.$name_.explore.tsx` (detail page has no Outlet).

## Decisions
- **D1 Facts from the committed HEAD tree only** (tracked files, no working tree). New git shapes after
  `GIT_FLAGS -C <abs>`: `ls-tree -r -l -z --full-tree HEAD`; `cat-file blob <40-hex oid>`;
  `diff --numstat -z --no-ext-diff --no-textconv --no-renames <empty-tree> HEAD`;
  `for-each-ref --sort=-creatordate --count=30 --format=… refs/tags`. gh: `api repos/<slug>/releases?per_page=20`.
  `RunDeps.maxStdoutBytes` (≤ 8 MiB; ls-tree/diff 4 MiB; null → truncated). Blobs 100644/100755 only.
  Caps: 50k entries, 256 KiB per file, prompt 60k chars (8k per file).
- **Read allowlist:** README*, CLAUDE.md, AGENTS.md, package.json, pyproject.toml, requirements*.txt, Cargo.toml,
  go.mod, build/settings.gradle(.kts), gradle/libs.versions.toml, .github/workflows/*.y?ml (yaml pkg),
  docs/**/*.md (first heading, 16 KiB), entry points {src/,}{index,main,app,server}.{ts,tsx,js,py,kt}.
- **Never read:** `.env*` (all, incl. .env.example), .npmrc, .pypirc, .netrc, .git-credentials, id_rsa*,
  id_ed25519*, *.pem/key/p12/pfx/jks/keystore/crt/cer/der/mobileprovision, *.tfstate*, credentials*, secrets*,
  service-account*.json, google-services.json, GoogleService-Info.plist, .ssh/ .aws/ .gnupg/.
  After read, drop on private-key header, AKIA…, gh[pousr]_/github_pat_, sk-ant-, sk-…, xox[baprs]-, AIza….
- **D2 First POST** `POST /api/cockpit/projects/:name/explain?head=<sha>`: Origin required + allowlisted (403,
  no ACAO), no body (400), simple request (no preflight; OPTIONS 405), other POST 405; C1 Host/loopback checks
  first. Single-flight per key; one generation at a time (429) and ≤ 6 per hour (429 + Retry-After).
- **D3 Model:** `listComplete` (8192 tokens, 120 s) injected; repo text through stripMarker then fenced with
  newMarker + "data, not instructions"; zod parse; output shown as plain text only. Explanation in French.
- **D4 Estimate:** ceil(prompt.length / 3.5) of the exact prompt + 8192 max output, via GET with `head`;
  POST with a different head → 409.
- **D5 Cache = files:** `~/.config/openduet/cockpit/explain/<sha256(realpath)[:16]>/<head>-v<PROMPT_VERSION>.json`,
  dir 0700, file 0600, temp + rename, keep last 3, zod re-check on read.
- **D6 UI:** header (HEAD, truncated), language bars, tree, manifests, release timeline (tags, releases, runs),
  docs, explanation panel (estimate, Generate, sections, SVG diagram, stale badge).

## Routes
`GET /explore` → ExploreFacts (TTL 10 min) · `GET /explain` → {head, promptVersion, estimate, cached,
staleCached} · `POST /explain?head=` → 200 / 409 / 429 / 502 (nothing cached) / 503 (no completer).
Types (ExploreFacts, Explanation with sections + diagram {nodes ≤ 20, edges ≤ 40}) in cockpit/types.ts,
mirrored in app lib/cockpit/explore.ts. Unknown edges and module paths not in the tree are dropped.

## Batches (red first)
- **B1 runner** run.ts: refuses config/checkout/gc; cat-file needs 40-hex oid; diff needs no-ext-diff +
  no-textconv; gh releases ok, other api refused; maxStdoutBytes clamped; C1 tests stay green.
- **B2 facts** secrets.ts, explore.ts (real temp repo): per-language counts, untracked ignored; .env/id_rsa/
  .pem never cat-file'd; private-key file dropped; symlink/submodule skipped; manifests and workflows parsed;
  tags newest first, releases null without remote; tree capped + truncated; empty repo → head null.
- **B3 explain** explain.ts: fence + strip; prompt ≤ 60k; estimate formula; bad JSON → error, no file;
  cache hit / miss on new commit or version; 2 concurrent → 1 call; 7th per hour → 429; 0600, tampered ignored.
- **B4 routes + wiring** server.ts, collect.ts, index.ts: POST no/foreign Origin 403; allowed 200 + ACAO;
  POST /projects 405; body 400; head mismatch 409; OPTIONS 405; unknown 404.
- **B5 UI** lib/cockpit/explore.ts, diagram-layout.ts (pure layered layout), explore route, link from detail:
  layout no overlap; `<script>` label shown literally; estimate shown before POST; live browser check.

## Out of scope
Editing projects, automatic regeneration, cross-project graphs.
