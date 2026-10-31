# Duet — single source of truth (sub-project D)

Date: 2026-10-30 · Status: draft for review · Owner: Wassim

## 1. Goal

Duet becomes the one place that knows everything Wassim must not miss: interviews, lead
follow-ups, bills and fines, deadlines, forgotten ideas in Apple Notes, and where each project
stands. It gathers these from his sources, stores them as **items**, and reminds him on his
iPhone even when the Mac is off.

This is the foundation for the later sub-projects, each with its own spec:
A. Missions (leads, interviews, follow-ups) · B. Projets (health check, next feature) ·
C. Personal growth (learn / apply) · E. Actions on the PC.

### Success criteria

- An interview in Google Calendar or a bill with a due date in Gmail becomes an active item
  with a reminder, with no action from Wassim.
- An idea or to-do written in Apple Notes shows up as a card to accept or dismiss.
- A reminder fires on the iPhone at the right time even if the Mac was off since the last sync.
- A source that could not be read is named in the brief, never reported as quiet.
- No item is created twice; a dismissed card never comes back.

## 2. Decisions taken

| Topic | Decision |
|---|---|
| Runtime | OpenDuet runs on the Mac, only when Wassim starts it (for now). |
| Store | Everything inside Duet (own database + Duet iOS app). No Todoist/Notion hub. |
| Intake mode | Mixed: clear items are added automatically, fuzzy ones become cards to swipe. |
| LinkedIn, Malt, Free-Work, Collective | Read through their notification emails in Gmail. No scraping (LinkedIn ToS). |
| Apple Notes | Read-only, through the existing Mac bridge. Duet never edits notes. |
| Paper mail (bills, fines) | Out of scope; Wassim can photograph it and send it to Duet in chat. |
| Payments | Duet never pays. Bills and fines are reminders only. |
| OpenBot code | Not modified where avoidable; new tables and modules live beside it. |

## 3. Existing pieces reused

- **Mac bridge**: the desktop app (Tauri) with `server/src/host-access` — list/read/write files and
  run commands on the Mac, each gated by approvals.
- **Proactive engine**: `server/src/proactive/engine.ts` — background check-ins that read only
  what is new since the last successful run and offer suggestions as swipeable cards.
- **Tasks**: `server/src/openduet/task-store.ts` and `openduet_tasks` — work Duet does itself.
- **Brief**: `server/src/openduet/brief.ts` and the `brief-du-matin` skill.
- **Channels**: Duet, Missions, Projets, Maison (`openbot/examples/wassim/channels.yaml`).
- **Mobile push**: `mobile/src/notifications.ts` (Expo push token).
- **Test fixture server**: the fake Google server used locally (port 4900).

## 4. Architecture

```
Sources ──► Intake (proactive check-in: at start, then every 30 min while running)
  Gmail ─ Malt / Free-Work / Collective / LinkedIn / bills / ANTAI (emails)
  Google Calendar
  Apple Notes    ─┐
  Local projects ─┴─ via the Mac bridge (desktop app)
  GitHub / Notion / Todoist (connectors, read-only)
        │
        ▼
Classifier ── clear  ──► item status=active
           └─ fuzzy  ──► item status=proposed (card)
        │
        ▼
openduet_items ──► brief ("Since last time")
               └─► iOS sync ──► local notifications
```

## 5. Data model — `openduet_items`

Kept separate from `openduet_tasks`: a task is work Duet does; an item is something for Wassim.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | |
| `ownerUserId` | text FK | |
| `kind` | text enum | `interview`, `followup`, `bill`, `fine`, `deadline`, `idea`, `todo`, `project_status` |
| `title` | text | required |
| `why` | text | why it matters, one sentence |
| `dueAt` | timestamptz | nullable |
| `remindAt` | timestamptz[] | default derived from kind (see 7) |
| `amount` | numeric + `currency` text | bills and fines only |
| `channelId` | text FK | Missions / Projets / Maison / Duet |
| `sourceApp` | text | `gmail`, `gcal`, `apple_notes`, `project`, `github`, `notion`, `todoist`, `chat` |
| `sourceLink` | text | deep link or message id |
| `sourceHash` | text unique per owner | dedup key: source + stable id (+ content hash for notes) |
| `status` | text enum | `proposed` → `active` → `done` / `dismissed` |
| `taskId` | text FK nullable | set when Duet takes the item on as a task |
| `createdAt`, `updatedAt`, `resolvedAt` | timestamptz | |

A second small table `openduet_intake_cursors` (`ownerUserId`, `scanner`, `lastSuccessAt`,
`cursor` jsonb) holds each scanner's position.

## 6. Intake

Each scanner is a skill with read-only tools, run by the proactive engine. It reads only what is
new since its cursor, and moves the cursor only on success.

1. **Mail scanner**: Gmail filtered by sender (Malt, Free-Work, Collective, LinkedIn, known
   billers, ANTAI). Extracts kind, title, date, amount, channel.
2. **Calendar scanner**: events whose title or description marks an interview or a client
   meeting become `interview` items.
3. **Notes scanner**: Apple Notes changed since the cursor, read through the Mac bridge with
   `osascript` (title, body, modified date). Detects ideas, to-dos and promises.
4. **Project scanner**: for each configured repo (local folder and/or GitHub): `session-notes.md`,
   last commit, open issues. Produces or updates one `project_status` item per project.

### Classification rule

- **Active (auto)**: kind is `interview`, `bill` or `fine`, and the date (and amount for
  bills/fines) was read explicitly from the source.
- **Proposed (card)**: everything else, and any item whose date or amount is uncertain.
- **Dedup**: an existing `sourceHash` is never inserted again, whatever its status.

## 7. Reminders on iOS

- Default `remindAt` by kind: interview → D-1 18:00 and 1 h before; bill/fine → D-3 09:00 and
  D-day 09:00; deadline → D-1 09:00; other kinds → none unless set.
- On each sync (app opened or foregrounded while the server is reachable) the app fetches active
  items with a `remindAt` in the next 14 days, cancels its previously scheduled local
  notifications, and schedules the new ones with `scheduleNotificationAsync`, soonest first,
  capped at 64 (iOS limit).
- Notification actions: **Done** and **Snooze 1 h**; tapping opens the item. Actions taken
  offline are queued and sent on the next sync.
- Remote push (existing) stays for urgent new items found while the server runs.

## 8. Brief

On server start, after the scanners run, the brief gains a **"Since last time"** part:
items added, cards waiting, anything due within 48 h, and the list of sources that could not be
read. The 30-minute check-ins stay silent unless something new was recorded.

## 9. Failures

- Mac bridge off, token expired, or a source error: the scanner fails, its cursor does not move,
  and the brief names the source and how to reconnect it.
- Parsing uncertainty never creates an active item; it creates a card.
- A scanner failure never blocks the other scanners.

## 10. Tests

- Server unit tests: one parser per sender with fixture emails (Malt, Free-Work, Collective,
  LinkedIn, a bill, an ANTAI notice); classification rule; dedup by `sourceHash`; cursor only
  moves on success.
- Notes scanner: fixture `osascript` output, no real Mac needed.
- Mobile: scheduling logic (14-day window, sort, 64 cap, cancel-and-replace, offline action queue).
- End to end: deliver fixture emails through the fake Google server and check the items and the
  brief.

## 11. Out of scope

Sub-projects A, B, C and E; paper mail OCR beyond what chat already handles; editing Apple
Notes; any payment; LinkedIn scraping; running Duet on a server.
