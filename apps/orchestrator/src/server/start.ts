// Minimal process entrypoint for the FR-24a HTTP server (createHttpServer,
// http-server.ts). Listens on PORT, defaulting to 4111 — the documented
// Mastra dev default (Spec 15 §4.1: `ORCHESTRATOR_BASE_URL` =
// `http://localhost:4111`).
//
// IMPORTANT: every route in http-server.ts calls
// `getOrchestratorRuntime()` (orchestrator.workflow.ts), which throws until
// `configureOrchestratorRuntime(...)` has been called with a real
// `graphWriter`/`monitoring`/`index`/`engine`/`auditLog` wiring. That
// runtime wiring (Neo4j driver, Spec 07's MonitoringAuditPort, the Mastra
// WorkflowEnginePort adapter, etc.) is out of this task's scope — it
// belongs to whatever boots the full Mastra app (this app's `mastra dev` /
// `mastra build` path, or a future `apps/orchestrator/src/server/runtime.ts`
// that composes the real adapters). Call `configureOrchestratorRuntime`
// before importing/starting this module in production use; for local
// exploration a test-double runtime (see
// apps/orchestrator/src/mastra/workflows/__tests__/orchestrator.workflow.test.ts
// for the shape of one) can be wired in ad hoc.
//
// SLA reminder scheduler (Spec 11 §11 Task 9): started below, AFTER
// `server.listen`, guarded to be fully optional — same posture as the
// pre-existing runtime-not-configured limitation above. If Slack env vars
// are missing (`getSlackAppDeps()` throws `SlackConfigError`) or
// `SENTINEL_SERVICE_JWT_SECRET` is unset, the scheduler is simply never
// started (logged once, never thrown) — this process still boots with
// zero Slack env vars, exactly like before this wiring was added. If the
// scheduler DOES start but `configureOrchestratorRuntime` was never
// called, its polling calls to `GET .../review-sla/due-soon-and-breached`
// will 500 (that route also calls `getOrchestratorRuntime()`); this is
// caught by `runSlaSchedulerCycle`'s own try/catch (`{ skipped: true }`,
// logged via `onCycleError`), never a crash — the same pre-existing
// runtime-wiring gap this file's header already documents, not a new one.
//
// How to run this file (no `tsx`/`ts-node` is a resolvable dependency of
// `apps/orchestrator` today — it exists only in the pnpm store as a
// devDependency of `packages/audit-ledger`/`packages/graph-db`, not
// hoisted here, and this task must not add a new dependency):
//   1. Compile then run the plain JS output (works today, zero new deps):
//        ./node_modules/.bin/tsc -p apps/orchestrator/tsconfig.json
//        node apps/orchestrator/dist/server/start.js
//   2. If `tsx` is later added as a devDependency of this package (matching
//      the convention already used by packages/audit-ledger and
//      packages/graph-db's own `migrate`/`seed` scripts):
//        tsx src/server/start.ts
//   Node's native `--experimental-strip-types` was tried and does NOT work
//   here out of the box: this codebase's relative imports use explicit
//   `.js` extensions (the correct ESM-with-TS-source convention) and
//   Node's type-stripping mode does not remap those to sibling `.ts` files
//   on disk, so it fails to resolve them without `tsx`/a bundler.
import { createHttpServer } from "./http-server.js";
import { getSlackAppDeps, SlackConfigError } from "../slack/app.js";
import { createHttpSlaBreachFeedPort, startSlaReminderScheduler } from "../slack/sla-reminder-scheduler.js";

const port = Number(process.env.PORT ?? 4111);

const server = createHttpServer();
server.listen(port, () => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", operation: "orchestrator-http-server-start", port }));
  startSlaSchedulerIfConfigured(port);
});

// ---------------------------------------------------------------------------
// Spec 11 §11 Task 9 wiring: the SLA reminder scheduler is an OPTIONAL
// supplementary surface, same posture as the /api/slack/* routes it feeds
// off (app.ts's `getSlackAppDeps` header comment: "never a fatal
// process-startup error"). It must never prevent this process from
// booting with zero Slack env vars configured, exactly like today.
//
// Reuses `getSlackAppDeps()` (app.ts) rather than re-validating
// SLACK_BOT_TOKEN/SLACK_SIGNING_SECRET/WEB_CONSOLE_BASE_URL a second time
// here — that call already gives us botToken/webConsoleBaseUrl/store/
// userMappingStore/dmCache, everything SlaSchedulerDeps needs except
// `escalationsChannelId` and `feed`, both constructed directly below.
// ---------------------------------------------------------------------------

function startSlaSchedulerIfConfigured(listenPort: number): void {
  let slackDeps: ReturnType<typeof getSlackAppDeps>;
  try {
    slackDeps = getSlackAppDeps();
  } catch (err) {
    if (err instanceof SlackConfigError) {
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "info",
          operation: "sla-reminder-scheduler-start",
          message: "SLA reminder scheduler not started: Slack is not configured for this deployment.",
          reason: err.message
        })
      );
      return;
    }
    throw err;
  }

  const serviceJwtSecret = process.env.SENTINEL_SERVICE_JWT_SECRET;
  if (!serviceJwtSecret) {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        operation: "sla-reminder-scheduler-start",
        message: "SLA reminder scheduler not started: SENTINEL_SERVICE_JWT_SECRET is not configured."
      })
    );
    return;
  }

  const feed = createHttpSlaBreachFeedPort(`http://localhost:${listenPort}`, serviceJwtSecret);
  startSlaReminderScheduler({
    feed,
    botToken: slackDeps.botToken,
    webConsoleBaseUrl: slackDeps.webConsoleBaseUrl,
    store: slackDeps.store,
    userMappingStore: slackDeps.userMappingStore,
    dmCache: slackDeps.dmCache,
    // No backup-reviewer registry/policy exists anywhere in the shipped
    // system (orchestrator.sla-feed.ts's header comment) — the real feed's
    // `breached` array is always `[]`, so this value is never actually
    // read by handleBreachedEntry today. Plumbed through only to satisfy
    // SlaSchedulerDeps' existing (not-yet-real) contract shape, exactly
    // like escalationsChannelId's own doc comment in
    // sla-reminder-scheduler.ts describes.
    escalationsChannelId: process.env.SLACK_ESCALATIONS_CHANNEL_ID ?? "",
    onCycleError: (err) => {
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          operation: "sla-reminder-scheduler-cycle",
          message: err instanceof Error ? err.message : String(err)
        })
      );
    }
  });
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), level: "info", operation: "sla-reminder-scheduler-start", message: "SLA reminder scheduler started." })
  );
}
