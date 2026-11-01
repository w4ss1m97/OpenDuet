# Duet C1c — Project explorer (micro-spec, not yet architect-reviewed)

Follows C1 (Cockpit Projects). One interactive page per cockpit project to understand it well.

## Goal
Per project: architecture (folders, modules, how they connect), languages, dependencies, commands,
MEP (releases, tags, deploy runs), specs and docs, plus an LLM explanation of how it works.

## Decisions (Wassim, 2026-11-01)
- Two layers. **Facts** computed in code, zero tokens: lines per language, manifests (package.json, pyproject,
  Gradle), folder tree, CI workflows, tags/releases (gh), specs in docs/.
- **Explanation** by the LLM: generated **on demand only** (a button, token estimate shown first), cached per
  project + HEAD commit; regenerate only when HEAD changed. No background generation.
- Reuses the C1 listener (127.0.0.1:3002), runner (git/gh allowlist) and path checks.

## Files (guesses marked ?)
- `openbot/server/src/openduet/cockpit/explore.ts` (facts), `explain.ts` (prompt, parse, cache).
- Cache: table or JSON file under the server data dir? (architect to decide).
- Routes: `GET /api/cockpit/projects/:name/explore`, `POST /api/cockpit/projects/:name/explain`
  (first POST on the cockpit listener: needs CSRF/Origin check from C1 D2).
- UI: `openbot/app/src/routes/_authed/_app/cockpit.projects.$name.explore.tsx` (tree, language bars,
  dependency list, MEP timeline, Mermaid/SVG architecture diagram from the explanation).

## Edge cases
- Repo text goes to the LLM inside a random-marker fence with a "data, not instructions" line.
- Never read or send `.env`, keys, certificates, or files matched by the C4 secret patterns; tracked files only.
- Big repos: cap the tree and pick key files (README, CLAUDE.md, manifests, entry points), byte budget.
- Projects without CI, tags or a GitHub remote.

## Tests
- Language counts from a temp repo; `.env` and key files never read; cache hit while HEAD is unchanged and
  miss after a new commit; prompt fences repo text and strips the marker; POST without allowed Origin → 403.

## Out of scope
Editing projects, automatic regeneration, cross-project graphs.
