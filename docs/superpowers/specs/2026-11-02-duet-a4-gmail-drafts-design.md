# Duet A4 — Gmail drafts (reviewed spec, architect, 2026-11-02)

Status: reviewed by the architect (Opus), built by Sonnet with red-first tests. Builds on A1 (missions, relances),
A2b (debrief follow-up already refreshes the relance body) and A3b (tailored CV PDF).

## Micro-spec (owner's 5 bullets)
1. Duet prepares mail drafts (mission relance, offer application with the tailored CV attached), stored in Duet,
   editable, and created as a Gmail **draft** only on the owner's explicit push. Duet never sends.
2. New REST tool `gmail_create_draft` on the google-workspace transport; scope `gmail.compose` added (gmail.send
   cannot create drafts). The tool is a write and goes through the normal approval gate.
3. Only the application cover message is LLM-written: offer text in a random-marker fence with a "data, not
   instructions" line, zod-parsed, length caps. The CV is attached as the A3b PDF, never re-written.
4. Recipients never come from LLM output (mission contact emails, or empty for alert offers); header injection
   refused; owner scoping on every query; claim pattern on push; a pushed draft cannot be pushed again.
5. Tests: MIME builder, tool against the fake Google, store, cover parsing, routes.

## Decisions
- No separate "reply to recruiter" kind in v1: a relance on a mission with a known thread is drafted as a reply in
  that thread. Free-form LLM replies wait for A4.2.
- A new table: relance rows have no subject, recipients, thread or attachment, and applications have no relance row.
- Drafts are created on demand only, never automatically alongside a relance.
- Scope: add `https://www.googleapis.com/auth/gmail.compose`, keep `gmail.send` (needed by `gmail_send_reply`).
  Sending power does not widen; compose adds reading/editing drafts. Gmail is not connected yet: no re-consent.
- No approval-gate bypass. `pluginStore.callTool` (src/plugins/plugin-store/calls.ts) asks the gate for every
  write. If it suspends, the push route answers 202 `approval_pending`; the owner approves in OpenBot ("allow
  always" stops further asks) and pushes again. Retries carry byte-identical args (built only from the stored row,
  PDF stored at creation), so the approved digest matches.
- The debrief follow-up already flows into the relance row body (A2b), so a relance draft picks it up for free.

## Tool `gmail_create_draft`
Args: `to?[] cc?[] subject body threadId? attachment? {filename, mimeType:"application/pdf", contentBase64}`.
Checks before any fetch: HEADER_BREAK in to/cc/subject/filename → refused; every address contains "@"; empty `to`
allowed; body non-empty ≤ 20 000 chars; attachment PDF only, decoded ≤ 2 MB, filename `^[A-Za-z0-9._-]{1,100}$`.
With `threadId`: GET `threads/{id}?format=metadata` (Message-ID/References/In-Reply-To), last message = parent,
threaded like replyMessage ("Re: " prefix); missing thread or Message-ID → refused. Then POST `drafts`
`{message:{raw, threadId?}}` → `{"draft":true,"id","messageId","threadId"}`. Never calls messages/send.
Pure exported `draftMessage(input)`: text/plain base64 without attachment; multipart/mixed with boundary
`duet-<uuid>` (absent from the parts) + PDF part (`Content-Disposition: attachment; filename="…"`, base64 76-char
lines) with one. replyMessage shares the header code with unchanged output.

## Table `openduet_mail_drafts` (schema `openduet-mail-drafts.ts`, listed in drizzle.config.ts, generated migration)
id PK; owner_user_id → users cascade; kind `relance|application`; mission_id → missions cascade null; relance_id →
relances set null; offer_id → offers cascade null; to_addrs/cc_addrs text[] default {}; subject; body; thread_id null;
attachment_pdf bytea null; attachment_name null; status `draft|pushed|dismissed`; gmail_draft_id null; claimed_at
null; last_error null; pushed_at null; created_at/updated_at. CHECKs: relance ⇒ mission_id; application ⇒ offer_id;
pushed ⇒ gmail_draft_id and pushed_at. Partial unique: (owner, relance_id) WHERE status='draft' AND relance_id NOT
NULL; (owner, offer_id) WHERE status='draft' AND kind='application'.

## Store `mail-drafts/store.ts` (owner-filtered; other owner → null → 404)
createDraft (returns the live one if it exists), getDraft, listDrafts(status?), patchDraft (draft and not claimed,
else conflict), claimPush (UPDATE … WHERE status='draft' AND (claimed_at IS NULL OR stale > 10 min) RETURNING),
completePush / releasePush (claim holder only), dismissDraft.

## Sources
- relance: body = relance row (same owner + mission, status draft, else 404/409); subject `Relance — <role ?? title>
  chez <company>`; to = mission contact emails (first 3); thread = mission's latest thread id or null.
- application: needs a ready CV version (else 409 `cv_not_ready`); PDF rendered once via the A3b renderer and
  stored (renderer missing → 503); to = [] unless the offer has a contact address. Cover (`mail-drafts/cover.ts`):
  `buildCoverPrompt(offer, profile, marker)`, `parseCover(text)` → zod `{subject ≤120, body 200..1500}`; French,
  claims only from the profile, no CV text, no TJM promise; bad answer → 503 `cover_failed`, no row; links not in
  the offer refused; marker stripped.

## Routes `/api/openduet/mail-drafts`
POST `/` (`{kind:"relance",missionId,relanceId}` | `{kind:"application",offerId}`) → 201 / 200 if it exists ·
GET `/`?status · GET `/:id` (hasAttachment, attachmentName, no bytes) · GET `/:id/attachment` (PDF, no-store) ·
PATCH `/:id` strict `{to?,cc?,subject? ≤200,body? ≤20000}` (header break / bad email → 400, not draft → 409) ·
POST `/:id/dismiss` · POST `/:id/push`: pushed → 409 `already_pushed`; claimed → 409 `push_in_progress`; else claim
and call `google-workspace/gmail_create_draft` as the owner (never proactiveInitiator): success → 200 pushed;
HeadlessToolSuspension → release, 202 `approval_pending`; refusal/tool error → release with error, 502.

## Not verified live
Gmail OAuth is not connected on this machine: everything is verified against `scripts/fake-google` only. Real Gmail
may treat empty `To` or the multipart draft differently; check on the first real push.

## Ordered test list
1. MIME: plain headers, encoded non-ASCII subject, threaded Re:/In-Reply-To/References, multipart boundary, PDF
   part lines and filename, replyMessage unchanged.
2. Tool (fake): unthreaded draft; threaded via threads.get; CRLF refused with no fetch; non-PDF/oversized refused;
   empty to allowed; missing thread refused; messages/send never hit.
3. Catalogue: gmail_create_draft in writeTools; scopes include compose and send.
4. Store: CHECKs, idempotent create, patch only while draft, parallel claim → one wins, stale claim, non-holder
   complete ignored, other owner → null, cascades.
5. Cover: fence + marker line, zod accept/reject, foreign link refused, marker stripped.
6. Routes: relance create, cross-mission 404, cv_not_ready 409, cover 503 no row, PATCH 400/409, push success, double
   push 409, concurrent push, gate 202 then identical retry, tool error 502, other owner 404 everywhere, dismiss.
