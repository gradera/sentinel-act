// Spec 15 §10 Test Plan — FR-35 handler unit test: /api/health calls its
// (mocked) dependency — a fetch to ORCHESTRATOR_BASE_URL/healthz — and
// maps success/failure to the correct status/HTTP code. Global `fetch` is
// mocked directly (no network, no real orchestrator process needed).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

describe("GET /api/health (FR-35)", () => {
  beforeEach(() => {
    process.env.ORCHESTRATOR_BASE_URL = "http://localhost:4111";
    delete process.env.HEALTH_CHECK_TIMEOUT_MS;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("returns 200/ok when the orchestrator's /healthz responds 200", async () => {
    global.fetch = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("web-console");
    expect(body.checks.orchestrator.status).toBe("ok");
    expect(global.fetch).toHaveBeenCalledWith("http://localhost:4111/healthz", expect.objectContaining({ method: "GET" }));
  });

  it("returns 503/degraded (not down — §5.3's rationale) when the orchestrator is unreachable", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.checks.orchestrator.status).toBe("down");
  });

  it("returns 503/degraded when the orchestrator's /healthz responds non-2xx", async () => {
    global.fetch = vi.fn(async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("degraded");
  });

  it("returns 503/degraded when ORCHESTRATOR_BASE_URL is not configured", async () => {
    delete process.env.ORCHESTRATOR_BASE_URL;
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.checks.orchestrator.status).toBe("down");
  });
});
