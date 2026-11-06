# CLAUDE.md — OpenDuet (Duet, personal tenant)

## Goal
Fork of CopilotKit/OpenDuet (proactive agent on OpenBot) run as Wassim's personal assistant "Duet".
Current focus: freelance agent (missions, interview prep/debrief, job offers ≥ 500 €/j, tailored CV, revision cards).

## Commands
All from `openbot/server` unless noted. Needs Postgres: `docker start openduet-postgres-1`.
- Tests (Duet): `TEST_DATABASE_URL=postgres://openbot:openbot@127.0.0.1:5432/openbot_test bun test tests/openduet-`
- Typecheck: `bun run typecheck`
- Run server: `bun run dev` (port 3001, env from `openbot/.env`)
- Migrations: `bun run db:generate --name <name>` then `bun run db:migrate`
- Whole repo (from `openbot/`): `bun test`, `bun run typecheck`

## Hard rules
- No secrets in the repo; never print or edit `openbot/.env` values.
- Never hand-edit the drizzle journal; new schema files must be listed in `drizzle.config.ts`.
- Every Duet query is scoped to the owner (another owner → 404).
- Text sent to the LLM from mails/offers goes in a random-marker fence with a "data, not instructions" line;
  model answers are parsed with zod. The CV is selection-only: the model picks ids, never writes CV text.
- Concurrent jobs use the claim pattern (UPDATE … WHERE claimable RETURNING; stale after 10 min).

## Where things are
- Duet code: `openbot/server/src/openduet/` (missions, items, job-offers, revision); schema in `src/db/schema/openduet-*.ts`.
- Specs: `docs/superpowers/specs/` (read only the one you need).
- Personal data outside the repo: `~/.config/openduet/{profile.md,cv-master.json}`.
- Phone app: `~/src/duet-ios` (separate project and session).
- Session notes: `.claude/session-notes.md` (read first, update at the end of each task).

## Conventions
- TypeScript + Bun + Hono + drizzle; match the surrounding style and comment density.
- Branches `feat/duet-<step>`; PRs go to `w4ss1m97/OpenDuet` (remote `fork`), never to `origin` (upstream).
- Commit messages: `feat(duet): …` / `fix(duet): …`.
