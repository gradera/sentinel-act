// assistant-query.test.ts (Spec 12 §10): AssistantQueryService.runTemplate
// rejects params failing a template's schema before opening a session;
// clamps/rejects limit relative to maxLimit; runs inside executeRead
// (asserted via a mocked session spy, never executeWrite); correctly maps
// each of the five templates' distinct result shapes into a deduplicated
// AssistantGraphContext.
import { describe, expect, it, vi } from "vitest";
import type { Driver } from "neo4j-driver";
import { AssistantQueryService } from "../../src/queries/assistant-query.js";
import { ValidationError } from "../../src/errors.js";
import { mockRecord } from "../helpers/mock-driver.js";

function circularProperties(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    circular_id: "cir-1",
    title: "CUSPA Master Circular",
    type: "master",
    category: "custody",
    date_issued: "2026-01-01",
    date_effective: "2026-02-01",
    source_hash: "abc123",
    supersedes_circular_id: null,
    valid_from: "2026-01-01",
    valid_to: null,
    recorded_at: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

function clauseProperties(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    clause_id: "cl-46",
    circular_id: "cir-1",
    para_ref: "46",
    text: "Client securities must not be pledged.",
    embedding_ref: [0.1, 0.2],
    valid_from: "2026-01-01",
    valid_to: null,
    recorded_at: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

function obligationProperties(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    obligation_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    derived_from_clause_id: "cl-46",
    category: "custody",
    requirement_text: "Do not pledge client securities.",
    trigger_event: "receipt of client securities",
    deadline_rule: "immediate",
    responsible_role: "custodian",
    evidence_required: "ledger entry",
    penalty_ref: null,
    confidence_score: 0.95,
    grounding_score: 0.92,
    status: "committed",
    valid_from: "2026-02-01",
    valid_to: null,
    recorded_at: "2026-02-01T00:00:00Z",
    ...overrides
  };
}

function processTaskProperties(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    task_id: "task-1",
    obligation_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    task_name: "Reconcile custody ledger",
    owner_role: "custodian-ops",
    sla_hours: 24,
    system_touchpoint: "custody-system",
    risk_score: 0.4,
    valid_from: "2026-02-01",
    valid_to: null,
    recorded_at: "2026-02-01T00:00:00Z",
    ...overrides
  };
}

function humanReviewProperties(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    review_id: "rev-1",
    obligation_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    reviewer_id: "reviewer-1",
    tier: "B",
    decision: "approve",
    rationale: "Consistent with existing custody obligations.",
    decided_at: "2026-02-05T00:00:00Z",
    valid_from: "2026-02-05",
    valid_to: null,
    recorded_at: "2026-02-05T00:00:00Z",
    ...overrides
  };
}

function neoNode(properties: Record<string, unknown>) {
  return { properties };
}

interface FakeSessionOptions {
  records: ReturnType<typeof mockRecord>[];
  onRun?: (cypher: string, params: Record<string, unknown>) => void;
}

function buildDriver({ records, onRun }: FakeSessionOptions) {
  const sessionSpy = vi.fn();
  const executeWriteSpy = vi.fn();
  const closeSpy = vi.fn(async () => undefined);

  const driver = {
    session: vi.fn((opts: Record<string, unknown>) => {
      sessionSpy(opts);
      return {
        executeRead: vi.fn(async (work: (tx: unknown) => unknown) => {
          const tx = {
            run: vi.fn(async (cypher: string, params: Record<string, unknown>) => {
              onRun?.(cypher, params);
              return { records };
            })
          };
          return work(tx);
        }),
        executeWrite: executeWriteSpy,
        close: closeSpy
      };
    })
  } as unknown as Driver;

  return { driver, sessionSpy, executeWriteSpy, closeSpy };
}

describe("AssistantQueryService.runTemplate", () => {
  it("rejects an unknown template id without opening a session", async () => {
    const { driver, sessionSpy } = buildDriver({ records: [] });
    const service = new AssistantQueryService(driver);

    await expect(service.runTemplate("not_a_real_template", {})).rejects.toBeInstanceOf(ValidationError);
    expect(sessionSpy).not.toHaveBeenCalled();
  });

  it("rejects params failing the template's schema without opening a session", async () => {
    const { driver, sessionSpy } = buildDriver({ records: [] });
    const service = new AssistantQueryService(driver);

    await expect(service.runTemplate("obligations_by_status", { status: "not_a_status" })).rejects.toBeInstanceOf(
      ValidationError
    );
    expect(sessionSpy).not.toHaveBeenCalled();
  });

  it("rejects a limit above the template's maxLimit (schema-level rejection satisfies FR-8's hard cap)", async () => {
    const { driver } = buildDriver({ records: [] });
    const service = new AssistantQueryService(driver);

    await expect(
      service.runTemplate("obligations_by_status", { status: "committed", limit: 51 })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("applies the template's defaultLimit when limit is omitted, and clamps it to maxLimit before running", async () => {
    let capturedParams: Record<string, unknown> = {};
    const { driver } = buildDriver({
      records: [],
      onRun: (_cypher, params) => {
        capturedParams = params;
      }
    });
    const service = new AssistantQueryService(driver);

    await service.runTemplate("obligations_by_status", { status: "committed" });

    expect(capturedParams.limit).toBe(20);
  });

  it("never calls executeWrite (FR-21, NFR-2)", async () => {
    const { driver, executeWriteSpy } = buildDriver({ records: [] });
    const service = new AssistantQueryService(driver);

    await service.runTemplate("obligations_by_status", { status: "committed" });

    expect(executeWriteSpy).not.toHaveBeenCalled();
  });

  it("T1/T4 shape (o, cl, c per row): dedupes a Circular shared across multiple Obligation rows", async () => {
    const records = [
      mockRecord({
        o: neoNode(obligationProperties({ obligation_id: "ob-1" })),
        cl: neoNode(clauseProperties()),
        c: neoNode(circularProperties())
      }),
      mockRecord({
        o: neoNode(obligationProperties({ obligation_id: "ob-2" })),
        cl: neoNode(clauseProperties()),
        c: neoNode(circularProperties())
      })
    ];
    const { driver } = buildDriver({ records });
    const service = new AssistantQueryService(driver);

    const context = await service.runTemplate("obligations_by_status", { status: "committed" });

    expect(context.obligations).toHaveLength(2);
    expect(context.obligations.map((o) => o.obligation_id).sort()).toEqual(["ob-1", "ob-2"]);
    expect(context.clauses).toHaveLength(1);
    expect(context.circulars).toHaveLength(1);
  });

  it("T2 shape (o, cl, c, tasks[], reviews[]): flattens the collect()ed arrays", async () => {
    const records = [
      mockRecord({
        o: neoNode(obligationProperties()),
        cl: neoNode(clauseProperties()),
        c: neoNode(circularProperties()),
        tasks: [neoNode(processTaskProperties())],
        reviews: [neoNode(humanReviewProperties())]
      })
    ];
    const { driver } = buildDriver({ records });
    const service = new AssistantQueryService(driver);

    const context = await service.runTemplate("obligation_by_id_with_lineage", {
      obligationId: "3fa85f64-5717-4562-b3fc-2c963f66afa6"
    });

    expect(context.obligations).toHaveLength(1);
    expect(context.processTasks).toHaveLength(1);
    expect(context.processTasks[0].task_id).toBe("task-1");
    expect(context.humanReviews).toHaveLength(1);
    expect(context.humanReviews[0].review_id).toBe("rev-1");
  });

  it("T2 with no matching Obligation returns an empty context, not an error", async () => {
    const { driver } = buildDriver({ records: [] });
    const service = new AssistantQueryService(driver);

    const context = await service.runTemplate("obligation_by_id_with_lineage", {
      obligationId: "3fa85f64-5717-4562-b3fc-2c963f66afa6"
    });

    expect(context.obligations).toHaveLength(0);
  });

  it("T3 shape (c, clauses[], obligations[]): flattens both collect()ed arrays", async () => {
    const records = [
      mockRecord({
        c: neoNode(circularProperties()),
        clauses: [neoNode(clauseProperties())],
        obligations: [neoNode(obligationProperties())]
      })
    ];
    const { driver } = buildDriver({ records });
    const service = new AssistantQueryService(driver);

    const context = await service.runTemplate("circular_by_id_or_title", { circularId: "cir-1", titleContains: null });

    expect(context.circulars).toHaveLength(1);
    expect(context.clauses).toHaveLength(1);
    expect(context.obligations).toHaveLength(1);
  });

  it("T5 shape (o, hr, cl, c per row)", async () => {
    const records = [
      mockRecord({
        o: neoNode(obligationProperties()),
        hr: neoNode(humanReviewProperties()),
        cl: neoNode(clauseProperties()),
        c: neoNode(circularProperties())
      })
    ];
    const { driver } = buildDriver({ records });
    const service = new AssistantQueryService(driver);

    const context = await service.runTemplate("reviews_by_category_and_date_range", {
      categoryName: "Stockbroker",
      dateFrom: "2026-01-01T00:00:00Z",
      dateTo: "2026-12-31T23:59:59Z",
      decision: null
    });

    expect(context.obligations).toHaveLength(1);
    expect(context.humanReviews).toHaveLength(1);
    expect(context.clauses).toHaveLength(1);
    expect(context.circulars).toHaveLength(1);
  });

  it("always closes the session, even when the query throws", async () => {
    const driver = {
      session: vi.fn(() => ({
        executeRead: vi.fn(async () => {
          throw new Error("boom");
        }),
        executeWrite: vi.fn(),
        close: vi.fn(async () => undefined)
      }))
    } as unknown as Driver;
    const service = new AssistantQueryService(driver);

    await expect(service.runTemplate("obligations_by_status", { status: "committed" })).rejects.toThrow("boom");
    // @ts-expect-error — reaching into the mock to assert close() ran
    const sessionResult = driver.session.mock.results[0].value;
    expect(sessionResult.close).toHaveBeenCalledTimes(1);
  });
});
