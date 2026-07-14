// FR-22..FR-24 unit tests: HMAC signature correctness, 2xx parsing,
// missing-externalId classification (FR-23), and the FR-22 status-code
// classification table. No real network — global `fetch` is stubbed.
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyHttpStatus, GenericWebhookAdapter } from "../adapters/generic-webhook.adapter.js";
import { AdapterCallError } from "../errors.js";
import type { CreateTicketRequest } from "../types.js";

function makeRequest(overrides: Partial<CreateTicketRequest> = {}): CreateTicketRequest {
  return {
    dedupeKey: "task-1",
    title: "File revised broker-dealer risk disclosure with exchange",
    description: "**Requirement:** ...",
    assignee: { externalAssigneeRef: "queue:compliance-ops", displayLabel: "Compliance Officer", isFallback: false },
    dueDate: "2026-07-15T00:00:00.000Z",
    priority: "P2_high",
    labels: ["sentinel-act", "tier:B", "category:reporting"],
    sourceRefs: { obligation_id: "obl-1", task_id: "task-1", circular_id: "circ-1", clause_para_ref: "46" },
    ...overrides
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("GenericWebhookAdapter", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("signs the exact raw request body bytes with HMAC-SHA256 and sends X-Sentinel-Signature", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { externalId: "ext-1", externalUrl: "https://tickets.example/ext-1" }));
    const adapter = new GenericWebhookAdapter({ url: "https://hooks.example/webhook", secret: "s3cr3t" });
    const request = makeRequest();

    const result = await adapter.createTicket(request);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.example/webhook");
    const body = init.body as string;
    expect(JSON.parse(body)).toEqual(request);
    const expectedSignature = `sha256=${createHmac("sha256", "s3cr3t").update(body, "utf8").digest("hex")}`;
    expect((init.headers as Record<string, string>)["X-Sentinel-Signature"]).toBe(expectedSignature);
    expect(result).toEqual({ externalTicketId: "ext-1", externalTicketUrl: "https://tickets.example/ext-1", raw: { externalId: "ext-1", externalUrl: "https://tickets.example/ext-1" } });
  });

  it("parses externalId/externalUrl from a valid 2xx response", async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { externalId: "ext-2" }));
    const adapter = new GenericWebhookAdapter({ url: "https://hooks.example/webhook", secret: "s3cr3t" });
    const result = await adapter.createTicket(makeRequest());
    expect(result.externalTicketId).toBe("ext-2");
    expect(result.externalTicketUrl).toBeNull();
  });

  it("classifies a 2xx response missing externalId as permanent (FR-23)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { somethingElse: true }));
    const adapter = new GenericWebhookAdapter({ url: "https://hooks.example/webhook", secret: "s3cr3t" });
    await expect(adapter.createTicket(makeRequest())).rejects.toMatchObject({ classification: "permanent" });
  });

  it.each([500, 502, 503, 429])("classifies HTTP %s as retryable (FR-22)", async (status) => {
    fetchMock.mockResolvedValue(jsonResponse(status, { error: "boom" }));
    const adapter = new GenericWebhookAdapter({ url: "https://hooks.example/webhook", secret: "s3cr3t" });
    await expect(adapter.createTicket(makeRequest())).rejects.toMatchObject({ classification: "retryable" });
  });

  it.each([400, 401, 403, 404, 422])("classifies HTTP %s (non-429 4xx) as permanent (FR-22)", async (status) => {
    fetchMock.mockResolvedValue(jsonResponse(status, { error: "bad request" }));
    const adapter = new GenericWebhookAdapter({ url: "https://hooks.example/webhook", secret: "s3cr3t" });
    await expect(adapter.createTicket(makeRequest())).rejects.toMatchObject({ classification: "permanent" });
  });

  it("classifies a network error as retryable", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const adapter = new GenericWebhookAdapter({ url: "https://hooks.example/webhook", secret: "s3cr3t" });
    await expect(adapter.createTicket(makeRequest())).rejects.toMatchObject({ classification: "retryable" });
  });

  it("classifies a timeout (AbortError) as retryable", async () => {
    fetchMock.mockImplementation(() => {
      const err = new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });
    const adapter = new GenericWebhookAdapter({ url: "https://hooks.example/webhook", secret: "s3cr3t", timeoutMs: 5 });
    await expect(adapter.createTicket(makeRequest())).rejects.toMatchObject({ classification: "retryable" });
  });

  it("updateTicket POSTs to {url}/{externalTicketId} with the fields payload, applying the same rules", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    const adapter = new GenericWebhookAdapter({ url: "https://hooks.example/webhook", secret: "s3cr3t" });
    const result = await adapter.updateTicket({ externalTicketId: "ext-1", fields: { comment: "superseded" } });
    expect(result.updated).toBe(true);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.example/webhook/ext-1");
  });

  it("updateTicket classifies a 5xx as retryable and a non-429 4xx as permanent", async () => {
    const adapter = new GenericWebhookAdapter({ url: "https://hooks.example/webhook", secret: "s3cr3t" });
    fetchMock.mockResolvedValue(jsonResponse(500, {}));
    await expect(adapter.updateTicket({ externalTicketId: "ext-1", fields: { comment: "x" } })).rejects.toMatchObject({
      classification: "retryable"
    });
    fetchMock.mockResolvedValue(jsonResponse(404, {}));
    await expect(adapter.updateTicket({ externalTicketId: "ext-1", fields: { comment: "x" } })).rejects.toMatchObject({
      classification: "permanent"
    });
  });
});

describe("classifyHttpStatus", () => {
  it("treats >=500 and 429 as retryable, everything else 4xx as permanent", () => {
    expect(classifyHttpStatus(500)).toBe("retryable");
    expect(classifyHttpStatus(503)).toBe("retryable");
    expect(classifyHttpStatus(429)).toBe("retryable");
    expect(classifyHttpStatus(400)).toBe("permanent");
    expect(classifyHttpStatus(422)).toBe("permanent");
  });
});

describe("AdapterCallError", () => {
  it("carries the classification through instanceof checks", () => {
    const err = new AdapterCallError("boom", "retryable");
    expect(err).toBeInstanceOf(AdapterCallError);
    expect(err.classification).toBe("retryable");
  });
});
