// Spec 11 §10 — "Signature-invalid request rejected before any Slack/
// Orchestrator call is attempted (assert zero mock-API invocations)."
// Exercises the actual HTTP dispatch layer (app.ts's dispatchSlackRequest),
// not just signature.ts in isolation, to prove verification really does
// run before any downstream call in the real request path (FR-22).
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeBackend = vi.hoisted(() => ({ instance: null as unknown as import("./fake-orchestrator-backend.js").FakeOrchestratorBackend }));

vi.mock("../orchestrator-client.js", async () => {
  const { FakeOrchestratorBackend } = await import("./fake-orchestrator-backend.js");
  const { ResumeReviewStepError } = await import("../resume-review-step-error.js");
  fakeBackend.instance = new FakeOrchestratorBackend();
  return {
    getReviewGate: vi.fn((obligationId: string, reviewerId: string, tier: "B" | "C" | "ESCALATE") => fakeBackend.instance.getReviewGate(obligationId, reviewerId, tier)),
    getClaimSlots: vi.fn((obligationId: string) => fakeBackend.instance.getClaimSlots(obligationId)),
    claimReviewSlot: vi.fn((obligationId: string, reviewerId: string) => fakeBackend.instance.claimReviewSlot(obligationId, reviewerId)),
    resumeReviewStep: vi.fn((input: unknown) => fakeBackend.instance.resumeReviewStep(input as never)),
    ResumeReviewStepError
  };
});

vi.mock("../slack-client.js", () => ({
  postMessage: vi.fn(async () => ({ ok: true, ts: "1.1", channel: "D1" })),
  updateMessage: vi.fn(async () => ({ ok: true })),
  openView: vi.fn(async () => ({ ok: true, view: { id: "V1" } })),
  updateView: vi.fn(async () => ({ ok: true })),
  openConversation: vi.fn(async () => ({ ok: true, channel: { id: "D1" } }))
}));

import { dispatchSlackRequest, SLACK_INTERACTIONS_PATH } from "../app.js";
import * as orchestratorClient from "../orchestrator-client.js";
import * as slackClient from "../slack-client.js";
import { SentCardStore } from "../delivery.js";
import { InMemorySlackUserMappingStore, DmChannelCache } from "../user-mapping.js";
import { SlackIdempotencyCache } from "../idempotency.js";

class FakeIncomingMessage extends EventEmitter {
  method = "POST";
  headers: Record<string, string> = {};
  constructor(
    public body: string,
    headers: Record<string, string>
  ) {
    super();
    this.headers = headers;
  }
  emitBody(): void {
    this.emit("data", Buffer.from(this.body));
    this.emit("end");
  }
}

class FakeServerResponse {
  statusCode = 0;
  body = "";
  writeHead(status: number): void {
    this.statusCode = status;
  }
  end(payload?: string): void {
    this.body = payload ?? "";
  }
}

describe("Signature-invalid /api/slack/interactions request is rejected before any Slack/Orchestrator call (FR-22)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function buildDeps() {
    return {
      config: { botToken: "xoxb-test", signingSecret: "correct-secret", webConsoleBaseUrl: "https://console.test" },
      idempotencyCache: new SlackIdempotencyCache(),
      botToken: "xoxb-test",
      webConsoleBaseUrl: "https://console.test",
      store: new SentCardStore(),
      userMappingStore: new InMemorySlackUserMappingStore([{ reviewerId: "officer-1", slackUserId: "U1", slackTeamId: "T1" }]),
      dmCache: new DmChannelCache()
    };
  }

  it("returns 401 and calls zero Slack Web API / Orchestrator functions when the signature is wrong", async () => {
    const body = "payload=" + encodeURIComponent(JSON.stringify({ type: "block_actions" }));
    const req = new FakeIncomingMessage(body, {
      "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
      "x-slack-signature": "v0=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    });
    const res = new FakeServerResponse();

    const dispatchPromise = dispatchSlackRequest(req as never, res as never, SLACK_INTERACTIONS_PATH, buildDeps() as never);
    req.emitBody();
    await dispatchPromise;

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "UNAUTHORIZED" });

    // Zero calls into either the Orchestrator bridge or the Slack Web
    // API — verification happened before any parsing/dispatch.
    expect(orchestratorClient.getReviewGate).not.toHaveBeenCalled();
    expect(orchestratorClient.claimReviewSlot).not.toHaveBeenCalled();
    expect(orchestratorClient.resumeReviewStep).not.toHaveBeenCalled();
    expect(slackClient.postMessage).not.toHaveBeenCalled();
    expect(slackClient.updateMessage).not.toHaveBeenCalled();
    expect(slackClient.openView).not.toHaveBeenCalled();
  });

  it("also rejects with 401 when the timestamp is outside the 5-minute replay window, even with a validly-computed signature for that (stale) timestamp", async () => {
    const { createHmac } = await import("node:crypto");
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 10 * 60);
    const body = "payload=abc";
    const sig = "v0=" + createHmac("sha256", "correct-secret").update(`v0:${staleTimestamp}:${body}`).digest("hex");
    const req = new FakeIncomingMessage(body, { "x-slack-request-timestamp": staleTimestamp, "x-slack-signature": sig });
    const res = new FakeServerResponse();

    const dispatchPromise = dispatchSlackRequest(req as never, res as never, SLACK_INTERACTIONS_PATH, buildDeps() as never);
    req.emitBody();
    await dispatchPromise;

    expect(res.statusCode).toBe(401);
    expect(orchestratorClient.getReviewGate).not.toHaveBeenCalled();
  });
});
