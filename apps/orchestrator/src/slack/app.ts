// Spec 11 §5.1, §11 Task 1/10 — the Slack gateway's HTTP surface, mounted
// under /api/slack/* on the SAME apps/orchestrator http-server.ts process
// (see that file's route-registration edit). "Bolt-for-JS style" per the
// spec's file list — event-handler dispatch by interactivity type,
// signature verification, ack-then-async — but NOT a literal `@slack/bolt`
// dependency: this repo has zero Slack SDK installed today, and
// http-server.ts already established the convention of a hand-rolled
// `node:http` server with "no framework dependency" (see that file's own
// header comment) specifically to avoid adding a web framework. Adding
// `@slack/bolt` (which bundles Express) would contradict that established,
// deliberate convention, so this module reproduces Bolt's REQUEST-HANDLING
// SHAPE (ack, dispatch-by-type, views.open-within-3s) using the same
// primitives http-server.ts already uses (node:http, hand-rolled JSON
// helpers) plus this unit's own signature.ts/idempotency.ts — zero new
// runtime dependencies.
import type { IncomingMessage, ServerResponse } from "node:http";
import { verifySlackSignature } from "./signature.js";
import { SlackIdempotencyCache, buildCompositeIdempotencyKey, buildSlackNativeIdempotencyKey } from "./idempotency.js";
import { parseInteractivityPayload, type SlackEventsEnvelope } from "./slack-payloads.js";
import { ActionNotAllowedForTierError, handleBlockActionsPayload, type BlockActionsHandlerDeps } from "./handlers/block-actions.js";
import { processViewSubmission, validateRationaleSubmission, type ViewSubmissionHandlerDeps } from "./handlers/view-submissions.js";
import type { RationaleModalMetadata } from "./types.js";
import { loadSlackGatewayConfig, SlackConfigError, type SlackGatewayConfig } from "./config.js";
import { SentCardStore } from "./delivery.js";
import { DmChannelCache, InMemorySlackUserMappingStore } from "./user-mapping.js";

// ---------------------------------------------------------------------------
// Low-level HTTP helpers — mirrors http-server.ts's own readBody/sendJson
// exactly (kept local rather than imported, since http-server.ts does not
// export them; duplicating ~15 lines is preferable to widening that
// file's export surface for two small utilities).
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer | string) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function getHeaderAsString(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function logSlackEvent(input: { outcome: string; [key: string]: unknown }): void {
  try {
    // NFR-Observability-1 shape: requestId/slackUserId/reviewerId/
    // obligationId/actionId/outcome/latencyMs. Never logs the raw body
    // (§8: "never with the raw body, may contain a rationale string") or
    // the Authorization/signing-secret values.
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", operation: "slack-gateway", ...input }));
  } catch {
    // Logging must never break the interaction path.
  }
}

// ---------------------------------------------------------------------------
// FR-22/FR-23: verification + dedup, run BEFORE any body parsing / Slack
// or Orchestrator call, on every request, no exceptions for any payload
// type.
// ---------------------------------------------------------------------------

export interface SlackAppDeps extends BlockActionsHandlerDeps, ViewSubmissionHandlerDeps {
  config: SlackGatewayConfig;
  idempotencyCache: SlackIdempotencyCache;
  /** Injectable clock for deterministic tests. */
  nowSeconds?: () => number;
  onAppUninstalled?: (teamId: string | undefined) => void;
  onTokensRevoked?: (teamId: string | undefined) => void;
}

async function handleInteractions(req: IncomingMessage, res: ServerResponse, deps: SlackAppDeps): Promise<void> {
  const start = Date.now();
  const rawBody = await readBody(req);

  const verification = verifySlackSignature({
    signingSecret: deps.config.signingSecret,
    timestampHeader: getHeaderAsString(req, "x-slack-request-timestamp"),
    signatureHeader: getHeaderAsString(req, "x-slack-signature"),
    rawBody,
    nowSeconds: deps.nowSeconds?.()
  });
  if (!verification.valid) {
    logSlackEvent({ outcome: "signature_rejected", reason: verification.reason });
    sendJson(res, 401, { error: "UNAUTHORIZED" });
    return;
  }

  const params = new URLSearchParams(rawBody);
  const payloadRaw = params.get("payload");
  let parsedJson: unknown;
  try {
    parsedJson = payloadRaw ? JSON.parse(payloadRaw) : null;
  } catch {
    sendJson(res, 400, { error: "INVALID_PAYLOAD" });
    return;
  }
  const payload = parseInteractivityPayload(parsedJson);
  if (!payload) {
    sendJson(res, 400, { error: "INVALID_PAYLOAD" });
    return;
  }

  if (payload.type === "view_closed") {
    // Accepted, deduped, acked — no action needed (a reviewer dismissed
    // the modal without submitting).
    sendJson(res, 200, {});
    return;
  }

  if (payload.type === "block_actions") {
    const action = payload.actions[0];
    const nativeKey = payload.trigger_id ? buildSlackNativeIdempotencyKey("trigger_id", payload.trigger_id) : null;
    const compositeKey = action
      ? buildCompositeIdempotencyKey({
          actionId: action.action_id,
          blockId: action.block_id,
          obligationId: action.value ? (JSON.parse(action.value) as { obligationId: string }).obligationId : "unknown",
          reviewerId: payload.user.id
        })
      : null;
    const key = nativeKey ?? compositeKey;
    if (key && deps.idempotencyCache.checkAndRecord(key)) {
      logSlackEvent({ outcome: "deduped", actionId: action?.action_id, slackUserId: payload.user.id });
      sendJson(res, 200, {});
      return;
    }

    try {
      const result = await handleBlockActionsPayload(payload, deps);
      logSlackEvent({ outcome: result.outcome, actionId: action?.action_id, slackUserId: payload.user.id, latencyMs: Date.now() - start });
      sendJson(res, 200, {});
    } catch (err) {
      if (err instanceof ActionNotAllowedForTierError) {
        logSlackEvent({ outcome: "action_not_allowed_for_tier", actionId: action?.action_id, slackUserId: payload.user.id });
        sendJson(res, 403, { error: err.code });
        return;
      }
      logSlackEvent({ outcome: "error", actionId: action?.action_id, slackUserId: payload.user.id, message: err instanceof Error ? err.message : String(err) });
      sendJson(res, 200, {}); // still ack — Slack does not need a 5xx here, the failure is logged/handled internally.
    }
    return;
  }

  // view_submission
  const viewKey = buildSlackNativeIdempotencyKey("view_id", payload.view.id);
  if (deps.idempotencyCache.checkAndRecord(viewKey)) {
    logSlackEvent({ outcome: "deduped", slackUserId: payload.user.id });
    sendJson(res, 200, {});
    return;
  }

  const metadata = JSON.parse(payload.view.private_metadata) as RationaleModalMetadata;
  const validation = validateRationaleSubmission(payload, metadata.tier);
  if (!validation.valid) {
    // FR-14: response_action:"errors" IS the ack — keeps the modal open,
    // no async processing happens for this submission.
    sendJson(res, 200, validation.response);
    return;
  }

  // FR-13: ack FIRST (closes the modal), THEN process asynchronously.
  sendJson(res, 200, {});
  processViewSubmission(payload, deps)
    .then((result) => {
      logSlackEvent({ outcome: result.outcome, errorCode: result.errorCode, slackUserId: payload.user.id, latencyMs: Date.now() - start });
    })
    .catch((err) => {
      logSlackEvent({ outcome: "error", slackUserId: payload.user.id, message: err instanceof Error ? err.message : String(err) });
    });
}

// ---------------------------------------------------------------------------
// §8 / §11 Task 10: app_uninstalled / tokens_revoked housekeeping. This
// unit does NOT subscribe to message/reaction events — keeping the OAuth
// scope surface minimal (§5.1).
// ---------------------------------------------------------------------------

async function handleEvents(req: IncomingMessage, res: ServerResponse, deps: SlackAppDeps): Promise<void> {
  const rawBody = await readBody(req);
  const verification = verifySlackSignature({
    signingSecret: deps.config.signingSecret,
    timestampHeader: getHeaderAsString(req, "x-slack-request-timestamp"),
    signatureHeader: getHeaderAsString(req, "x-slack-signature"),
    rawBody,
    nowSeconds: deps.nowSeconds?.()
  });
  if (!verification.valid) {
    logSlackEvent({ outcome: "signature_rejected", reason: verification.reason });
    sendJson(res, 401, { error: "UNAUTHORIZED" });
    return;
  }

  let envelope: SlackEventsEnvelope;
  try {
    envelope = JSON.parse(rawBody) as SlackEventsEnvelope;
  } catch {
    sendJson(res, 400, { error: "INVALID_PAYLOAD" });
    return;
  }

  if (envelope.type === "url_verification") {
    // One-time Slack Events API handshake.
    sendJson(res, 200, { challenge: envelope.challenge });
    return;
  }

  if (envelope.type === "event_callback" && envelope.event) {
    if (envelope.event.type === "app_uninstalled") {
      logSlackEvent({ outcome: "app_uninstalled", teamId: envelope.team_id });
      deps.onAppUninstalled?.(envelope.team_id);
    } else if (envelope.event.type === "tokens_revoked") {
      logSlackEvent({ outcome: "tokens_revoked", teamId: envelope.team_id });
      deps.onTokensRevoked?.(envelope.team_id);
    }
  }

  sendJson(res, 200, {});
}

// ---------------------------------------------------------------------------
// Route registration surface — http-server.ts calls these two functions
// for the two paths this unit owns (§5.1): POST /api/slack/interactions,
// POST /api/slack/events.
// ---------------------------------------------------------------------------

export const SLACK_INTERACTIONS_PATH = "/api/slack/interactions";
export const SLACK_EVENTS_PATH = "/api/slack/events";

export function createSlackAppDeps(overrides: Partial<SlackAppDeps> & Pick<SlackAppDeps, "botToken" | "webConsoleBaseUrl" | "store" | "userMappingStore" | "dmCache">): SlackAppDeps {
  return {
    config: loadSlackGatewayConfig(),
    idempotencyCache: new SlackIdempotencyCache(),
    ...overrides
  } as SlackAppDeps;
}

export async function dispatchSlackRequest(req: IncomingMessage, res: ServerResponse, pathname: string, deps: SlackAppDeps): Promise<boolean> {
  if (req.method === "POST" && pathname === SLACK_INTERACTIONS_PATH) {
    await handleInteractions(req, res, deps);
    return true;
  }
  if (req.method === "POST" && pathname === SLACK_EVENTS_PATH) {
    await handleEvents(req, res, deps);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Process-lifetime singleton wiring for http-server.ts. Mirrors
// orchestrator.workflow.ts's own configureOrchestratorRuntime/
// getOrchestratorRuntime lazy-singleton pattern. If SLACK_BOT_TOKEN/
// SLACK_SIGNING_SECRET/WEB_CONSOLE_BASE_URL are not configured (e.g. a
// dev environment intentionally running without Slack wired up), this
// throws SlackConfigError — http-server.ts's route dispatcher treats that
// as "Slack routes not mounted for this deployment" (404), never a fatal
// process-startup error, since this unit is explicitly a supplementary
// surface (§2 Non-Goals: "not a replacement for the console").
// ---------------------------------------------------------------------------

let singletonDeps: SlackAppDeps | null = null;

export function getSlackAppDeps(): SlackAppDeps {
  if (!singletonDeps) {
    const config = loadSlackGatewayConfig();
    singletonDeps = {
      config,
      botToken: config.botToken,
      webConsoleBaseUrl: config.webConsoleBaseUrl,
      store: new SentCardStore(),
      userMappingStore: new InMemorySlackUserMappingStore(),
      dmCache: new DmChannelCache(),
      idempotencyCache: new SlackIdempotencyCache()
    };
  }
  return singletonDeps;
}

/** Test-only reset — mirrors the pattern other singleton-runtime modules
 *  in this app would need for isolated test runs. */
export function resetSlackAppDepsForTests(): void {
  singletonDeps = null;
}

export { SlackConfigError };
