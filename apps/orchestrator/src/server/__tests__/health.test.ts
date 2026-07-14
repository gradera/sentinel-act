// Spec 15 §10 Test Plan / §11 Task 12 — unit tests for health.ts.
//
// FR-33: /healthz MUST NOT touch a dependency client. Proven here by
// never mocking @sentinel-act/graph-db/@sentinel-act/audit-ledger for
// buildHealthzResponse's own describe block, and asserting its shape,
// rather than by asserting a spy was never called (no dependency import
// exists in health.ts's handleHealthz path in the first place — see
// http-server.ts's own route split).
//
// FR-34: /readyz calls (mocked) dependency clients and maps success/
// failure/timeout to the correct status. @sentinel-act/graph-db and
// @sentinel-act/audit-ledger are mocked below so this suite never needs a
// real Neo4j/Postgres instance (or Docker) to run.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSession = { run: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
const mockDriver = { session: vi.fn(() => mockSession) };
const mockPool = { query: vi.fn(async () => undefined) };

vi.mock("@sentinel-act/graph-db", () => ({
  getDriver: () => mockDriver,
  getSingletonDatabase: () => "neo4j"
}));

vi.mock("@sentinel-act/audit-ledger", () => ({
  getPool: () => mockPool
}));

import { buildHealthzResponse, buildReadyzResult } from "../health.js";

describe("buildHealthzResponse (FR-33 — liveness only, never touches a dependency)", () => {
  it("returns status ok with the HealthCheckResponse shape and no checks field", () => {
    const body = buildHealthzResponse();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("orchestrator");
    expect(typeof body.version).toBe("string");
    expect(typeof body.timestamp).toBe("string");
    expect(new Date(body.timestamp).toString()).not.toBe("Invalid Date");
    expect(body.checks).toBeUndefined();
    expect(mockDriver.session).not.toHaveBeenCalled();
    expect(mockPool.query).not.toHaveBeenCalled();
  });
});

describe("buildReadyzResult (FR-34)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.HEALTH_CHECK_TIMEOUT_MS;
  });

  afterEach(() => {
    mockSession.run.mockReset().mockImplementation(async () => undefined);
    mockPool.query.mockReset().mockImplementation(async () => undefined);
  });

  it("returns 200/ok when both Neo4j and Postgres checks succeed", async () => {
    const { httpStatus, body } = await buildReadyzResult();
    expect(httpStatus).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.checks?.neo4j.status).toBe("ok");
    expect(body.checks?.postgres.status).toBe("ok");
    expect(mockSession.run).toHaveBeenCalledWith("RETURN 1");
    expect(mockPool.query).toHaveBeenCalledWith("SELECT 1");
  });

  it("returns 503/down when the Neo4j check fails, even if Postgres succeeds", async () => {
    mockSession.run.mockImplementation(async () => {
      throw new Error("connection refused");
    });
    const { httpStatus, body } = await buildReadyzResult();
    expect(httpStatus).toBe(503);
    expect(body.status).toBe("down");
    expect(body.checks?.neo4j.status).toBe("down");
    expect(body.checks?.neo4j.error).toContain("connection refused");
    expect(body.checks?.postgres.status).toBe("ok");
  });

  it("returns 503/down when the Postgres check fails, even if Neo4j succeeds", async () => {
    mockPool.query.mockImplementation(async () => {
      throw new Error("password authentication failed");
    });
    const { httpStatus, body } = await buildReadyzResult();
    expect(httpStatus).toBe(503);
    expect(body.status).toBe("down");
    expect(body.checks?.postgres.status).toBe("down");
    expect(body.checks?.neo4j.status).toBe("ok");
  });

  it("times out per HEALTH_CHECK_TIMEOUT_MS and reports the dependency as down", async () => {
    process.env.HEALTH_CHECK_TIMEOUT_MS = "20";
    mockSession.run.mockImplementation(() => new Promise(() => undefined)); // never resolves
    const { httpStatus, body } = await buildReadyzResult();
    expect(httpStatus).toBe(503);
    expect(body.checks?.neo4j.status).toBe("down");
    expect(body.checks?.neo4j.error).toContain("timed out");
  });
});
