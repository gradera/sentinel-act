# Spec 11 — Manual Slack Sandbox Verification Runbook

Per Spec 11 §11 Task 12 / §12 Definition of Done: there is no fully
automated Slack e2e in this build (real Slack workspace interaction is
inherently a third-party integration point). This script is executed
**once per PR that touches `handlers/` or `blocks.ts`**, and its
screenshots/notes are attached to that PR for review — it does not run in
CI.

## Prerequisites (one-time setup, Task 1)

1. Create a Slack app in a **sandbox** workspace (never production) via
   <https://api.slack.com/apps> → "Create New App" → "From scratch".
2. Under **OAuth & Permissions**, add these Bot Token Scopes (§5.2):
   `chat:write`, `im:write`, `users:read`, `users:read.email`.
3. Under **Interactivity & Shortcuts**, turn interactivity ON and set the
   Request URL to `https://<your-dev-tunnel>/api/slack/interactions`
   (use `ngrok`/`cloudflared` or similar to tunnel to a local
   `apps/orchestrator` dev server).
4. Under **Event Subscriptions**, turn events ON, set the Request URL to
   `https://<your-dev-tunnel>/api/slack/events`, and subscribe to the
   `app_uninstalled` and `tokens_revoked` bot events only (§5.1 — this
   unit deliberately does not subscribe to message/reaction events).
5. Install the app to the sandbox workspace. Capture:
   - The **Signing Secret** (Basic Information) → `SLACK_SIGNING_SECRET`
   - The **Bot User OAuth Token** (`xoxb-...`) → `SLACK_BOT_TOKEN`
6. Create two real (or sandbox-only) Slack user accounts in the sandbox
   workspace — these play "reviewer A" and "reviewer B" for the Tier C
   independence walkthrough.
7. Seed `SlackUserMapping` entries for both accounts (§13: no
   self-service UI in this build — construct an
   `InMemorySlackUserMappingStore` seeded with
   `{ reviewerId, slackUserId, slackTeamId }` for each account, wired
   into `getSlackAppDeps()` for this manual run, or temporarily hardcode
   the seed array while testing).
8. Set `apps/orchestrator/.env`: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`,
   `WEB_CONSOLE_BASE_URL`, `SENTINEL_SERVICE_JWT_SECRET` (matching
   whatever the Orchestrator process uses for `assertServiceAuth`).

## Walkthrough A — Tier B single sign-off (Journey A/E)

1. Trigger (or simulate, via a direct call to whatever seeds a suspended
   Tier B run in your dev Orchestrator) a Tier B review suspension for a
   test obligation, with reviewer A's `reviewerId` as the assignee.
2. **Screenshot 1**: reviewer A's Slack DM — confirm it shows exactly the
   FR-1 field set (circular title + summary, confidence/grounding/risk
   scores, top tier reason, SLA countdown, Approve/Decline/"Open full
   detail" buttons) and nothing else (no full clause text, no diff).
3. Click **Approve**. **Screenshot 2**: the rationale modal opens
   (`optional: true` for Tier B — rationale field present but not
   required).
4. Submit with an empty rationale. **Screenshot 3**: the modal closes
   immediately (FR-13's ack), and shortly after, the original DM updates
   (FR-16) to a static confirmation with no more clickable buttons.
5. Confirm in the console (Spec 09 queue) that the same obligation now
   shows `committed` / the recorded decision — same underlying fact.

## Walkthrough B — Tier C independence (Journey B/E, the critical path)

1. Trigger a Tier C suspension for a test obligation, eligible reviewer
   pool = {A, B}.
2. **Screenshot 4 (A's DM) and Screenshot 5 (B's DM)**, taken as close to
   simultaneously as practical — confirm both received an independent
   card (FR-7), neither message shows any hint of the other's identity or
   state beyond "eligible reviewer pool" framing.
3. As reviewer A: click **Approve**, submit with a non-empty rationale
   (Tier C requires one — confirm the modal rejects an empty submission
   first, FR-14, **Screenshot 6**: the inline validation error).
4. Immediately after A submits: **Screenshot 7 (B's DM)** — confirm B's
   card has NOT changed to reveal A's decision/rationale/name in any way.
   If B had not yet claimed a slot, B's card should still show
   Approve/Decline (or, if the claim step already updated it, the bare
   "a slot is no longer open" language per FR-9 — never A's identity or
   decision).
5. As reviewer B: click **Decline** (an intentional disagreement, to
   exercise the escalation path), submit with a rationale.
6. **Screenshot 8 (A's DM) and Screenshot 9 (B's DM)** — confirm BOTH now
   show the reveal (both `HumanReview` records, FR-11), and the console
   (Spec 09) shows the obligation as `escalated` (Journey B's
   maker-checker disagreement path).
7. Attach Screenshots 4–9 to the PR with a one-line note per screenshot
   confirming what was and was not visible, per NFR-Security-1's exact
   wording ("no Slack message they can read may contain the peer's
   decision/rationale/reviewer_id/decided_at before both have submitted").

## Walkthrough C — ESCALATE link-only card (Journey D, Fix 2)

1. Trigger an ESCALATE-tier item (a contradiction).
2. **Screenshot 10**: confirm the delivered card has NO Approve/Decline
   buttons at all — only "Open in console →". Manually attempt to
   right-click / inspect the message (Slack's own message actions menu)
   to confirm there is no hidden/disabled action either.

## Walkthrough D — Signals (Journey C, SLA reminder + breach)

1. Seed (or wait for, if your dev Orchestrator's SLA clock is
   compressed for testing) a due-soon transition on a suspended Tier B/C
   item. **Screenshot 11**: the existing card updates in place (not a new
   message) with the `⏰ Reminder` line and a refreshed countdown.
2. Seed a breach + backup-reviewer reassignment. **Screenshot 12**: the
   original reviewer's card shows "reassigned, SLA missed" with no
   actions; **Screenshot 13**: the backup reviewer receives a NEW DM with
   the catch-up card, including the "why you're seeing this" line;
   **Screenshot 14**: `#sentinel-act-escalations` shows the loud channel
   post naming both reviewers and the obligation.

## Sign-off

- [ ] Walkthrough A completed, screenshots attached
- [ ] Walkthrough B completed, screenshots attached — reviewer confirms
      no leak was visible at any captured step
- [ ] Walkthrough C completed, screenshot attached
- [ ] Walkthrough D completed, screenshots attached
- [ ] PR description links this file and lists the screenshot set
