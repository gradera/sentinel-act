// GenericWebhookAdapter — the concrete reference TicketingAdapter
// implementation (FR-22..FR-24, §5.4). Uses Node's native `fetch`/
// `AbortController` (Node >=20 per this repo's root package.json
// engines field — no extra HTTP client dependency needed).
import { createHmac } from "node:crypto";
import type { CreateTicketRequest, CreateTicketResult, TicketingAdapter, UpdateTicketRequest, UpdateTicketResult } from "../types.js";
import { AdapterCallError } from "../errors.js";

export interface GenericWebhookAdapterConfig {
  url: string;
  secret: string;
  timeoutMs?: number; // default 10_000
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** NFR-3: never let TICKETING_WEBHOOK_SECRET or credential-shaped fields
 *  leak into a persisted/logged `raw` response body. The generic webhook
 *  receiver never actually echoes the secret back (it's only used to
 *  compute the outbound HMAC header), but this is a defensive redaction
 *  in case a misconfigured/malicious receiver ever does. */
const SENSITIVE_KEY_PATTERN = /secret|token|password|authorization/i;

function redact(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : redact(val);
  }
  return out;
}

/** FR-22: HMAC-SHA256 over the exact raw request body bytes. */
function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

type PostOutcome = { kind: "response"; status: number; text: string } | { kind: "network_error"; message: string };

async function postJson(url: string, body: string, secret: string, timeoutMs: number): Promise<PostOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sentinel-Signature": `sha256=${sign(body, secret)}`
      },
      body,
      signal: controller.signal
    });
    const text = await response.text();
    return { kind: "response", status: response.status, text };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { kind: "network_error", message: `request timed out after ${timeoutMs}ms` };
    }
    return { kind: "network_error", message: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** FR-22: >=500, a network error, a timeout, or 429 -> retryable; any
 *  other 4xx -> permanent. */
export function classifyHttpStatus(status: number): "retryable" | "permanent" {
  if (status >= 500 || status === 429) {
    return "retryable";
  }
  return "permanent";
}

export class GenericWebhookAdapter implements TicketingAdapter {
  readonly adapterName = "generic-webhook";
  private readonly timeoutMs: number;

  constructor(private readonly config: GenericWebhookAdapterConfig) {
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** FR-22/FR-23: POST the request body as JSON, HMAC-signed. A 2xx
   *  response MUST have a non-empty string `externalId` (FR-23), else
   *  classified permanent. */
  async createTicket(request: CreateTicketRequest): Promise<CreateTicketResult> {
    const body = JSON.stringify(request);
    const outcome = await postJson(this.config.url, body, this.config.secret, this.timeoutMs);

    if (outcome.kind === "network_error") {
      throw new AdapterCallError(`generic-webhook createTicket network error: ${outcome.message}`, "retryable");
    }
    if (outcome.status < 200 || outcome.status >= 300) {
      throw new AdapterCallError(`generic-webhook createTicket failed with HTTP ${outcome.status}`, classifyHttpStatus(outcome.status));
    }

    let parsed: unknown;
    try {
      parsed = outcome.text.length > 0 ? JSON.parse(outcome.text) : {};
    } catch {
      throw new AdapterCallError("generic-webhook createTicket returned a non-JSON 2xx response body.", "permanent");
    }

    const parsedBody = parsed as { externalId?: unknown; externalUrl?: unknown };
    if (typeof parsedBody.externalId !== "string" || parsedBody.externalId.length === 0) {
      throw new AdapterCallError("generic-webhook createTicket 2xx response missing a non-empty externalId (FR-23).", "permanent");
    }

    return {
      externalTicketId: parsedBody.externalId,
      externalTicketUrl: typeof parsedBody.externalUrl === "string" ? parsedBody.externalUrl : null,
      raw: redact(parsed)
    };
  }

  /** FR-24: fully implemented per the port contract even though no v1
   *  functional requirement calls it. Mirrors createTicket's PATCH-style
   *  JSON body against `{url}/{externalTicketId}`, same signature/
   *  timeout/retry-classification rules. */
  async updateTicket(request: UpdateTicketRequest): Promise<UpdateTicketResult> {
    const body = JSON.stringify(request.fields);
    const url = `${this.config.url}/${encodeURIComponent(request.externalTicketId)}`;
    const outcome = await postJson(url, body, this.config.secret, this.timeoutMs);

    if (outcome.kind === "network_error") {
      throw new AdapterCallError(`generic-webhook updateTicket network error: ${outcome.message}`, "retryable");
    }
    if (outcome.status < 200 || outcome.status >= 300) {
      throw new AdapterCallError(`generic-webhook updateTicket failed with HTTP ${outcome.status}`, classifyHttpStatus(outcome.status));
    }

    let parsed: unknown = null;
    try {
      parsed = outcome.text.length > 0 ? JSON.parse(outcome.text) : null;
    } catch {
      parsed = null;
    }

    return { updated: true, raw: redact(parsed) };
  }
}
