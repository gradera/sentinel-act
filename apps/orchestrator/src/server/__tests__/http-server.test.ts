// Spec 08 gap-closure — http-server.ts's new
// GET /api/orchestrator/review-sla/due-soon-and-breached route.
//
// No http-server.test.ts existed before this file, and http-server.ts's
// existing six routes have zero dedicated HTTP-transport-level test
// coverage (they are only exercised indirectly, through the pure
// `handleReviewGateRequest`/`handleClaimRequest`/`resumeOrchestratorRun`
// functions they wrap, in orchestrator.workflow.test.ts /
// orchestrator.workflow.integration.test.ts). This file adds the first
// real end-to-end coverage of this process's actual HTTP surface for the
// one route this task added, using only Node's built-in `node:http`
// server (already what createHttpServer returns) and global `fetch` — no
// new dependency. The pure due-soon/breached computation itself is
// already exhaustively covered at the function level in
// orchestrator.sla-feed.test.ts; this file only proves the route is wired
// correctly (auth gate, path, JSON body).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHttpServer } from "../http-server.js";
import { configureOrchestratorRuntime } from "../../mastra/workflows/orchestrator.workflow.js";
import type { OrchestratorRuntime } from "../../mastra/workflows/orchestrator.workflow.js";
import { InMemorySuspendedRunIndex } from "../../mastra/workflows/orchestrator.logic.js";

const SECRET = "http-server-test-secret";

// Mirrors orchestrator.workflow.integration.test.ts's own `makeJwt` helper
// (verifyServiceJwt's minimal HS256 shape).
function makeJwt(secret: string): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = enc({ alg: "HS256", typ: "JWT" });
  const payload = enc({ sub: "svc", exp: Math.floor(Date.now() / 1000) + 3600 });
  const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

describe("GET /api/orchestrator/review-sla/due-soon-and-breached", () => {
  let server: Server;
  let baseUrl: string;
  let index: InMemorySuspendedRunIndex;

  beforeAll(async () => {
    process.env.SENTINEL_SERVICE_JWT_SECRET = SECRET;
    index = new InMemorySuspendedRunIndex();

    const runtime: OrchestratorRuntime = {
      graphWriter: { commitProposal: async () => ({ committed: true }) as never },
      monitoring: { recordHumanReview: async () => ({}) as never, getReviewsVisibleTo: async () => [] },
      index,
      auditLog: async () => undefined,
      engine: {
        start: async () => ({ runId: "unused" }),
        resume: async () => ({ finalStatus: "still_pending" as const }),
        currentSuspendedStep: async () => null,
        getMakerReviewerId: async () => null,
        getObligationStatus: async () => "still_pending" as const
      },
      referenceNow: () => new Date().toISOString()
    };
    configureOrchestratorRuntime(runtime);

    server = createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("401s without a valid service JWT", async () => {
    const response = await fetch(`${baseUrl}/api/orchestrator/review-sla/due-soon-and-breached`);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("UNAUTHORIZED");
  });

  it("401s with a malformed bearer token", async () => {
    const response = await fetch(`${baseUrl}/api/orchestrator/review-sla/due-soon-and-breached`, {
      headers: { authorization: "Bearer not-a-real-jwt" }
    });
    expect(response.status).toBe(401);
  });

  it("200s with the real computed body when authenticated, reflecting live suspended-run state", async () => {
    // A claimed Tier C entry, suspended 11.5h ago on a 12h SLA — inside
    // the 4h due-soon window, so it must appear.
    const suspendedAt = new Date(Date.now() - 11.5 * 60 * 60 * 1000).toISOString();
    await index.record({ obligation_id: "obl-http-1", runId: "run-http-1", stepId: "awaitHumanReview", tier: "C", suspendedAt });
    await index.claim("obl-http-1", "reviewer-http");

    const response = await fetch(`${baseUrl}/api/orchestrator/review-sla/due-soon-and-breached`, {
      headers: { authorization: `Bearer ${makeJwt(SECRET)}` }
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { dueSoon: Array<{ obligationId: string; reviewerId: string; slaDueAt: string }>; breached: unknown[] };
    expect(body.dueSoon).toEqual([
      expect.objectContaining({ obligationId: "obl-http-1", reviewerId: "reviewer-http" })
    ]);
    expect(body.breached).toEqual([]);
  });
});
