// Spec 11 FR-22 — Slack's documented v0 request-signing scheme.
// `POST /api/slack/interactions` and `/api/slack/events` MUST verify
// `X-Slack-Signature` against an HMAC-SHA256 of
// `v0:{X-Slack-Request-Timestamp}:{raw body}` keyed by
// SLACK_SIGNING_SECRET, and MUST reject any request where
// abs(now - timestamp) > 5 minutes. Verification MUST run before the raw
// body is parsed as JSON/form data, on every request, no exceptions for
// any payload type — this module therefore operates on the raw string
// body only, never a parsed object.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SLACK_SIGNATURE_VERSION = "v0";
export const SLACK_REPLAY_WINDOW_SECONDS = 5 * 60;

export type SlackSignatureFailureReason = "missing_headers" | "timestamp_out_of_range" | "signature_mismatch";

export type SlackSignatureVerificationResult =
  | { valid: true }
  | { valid: false; reason: SlackSignatureFailureReason };

export interface VerifySlackSignatureInput {
  signingSecret: string;
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  rawBody: string;
  /** Injectable for tests; defaults to the real wall clock. Seconds since
   *  epoch, matching Slack's X-Slack-Request-Timestamp unit. */
  nowSeconds?: number;
}

function computeSignature(signingSecret: string, timestamp: string, rawBody: string): string {
  const base = `${SLACK_SIGNATURE_VERSION}:${timestamp}:${rawBody}`;
  const digest = createHmac("sha256", signingSecret).update(base).digest("hex");
  return `${SLACK_SIGNATURE_VERSION}=${digest}`;
}

/** FR-22. Never throws — every failure path returns a tagged result so
 *  callers can 401 uniformly without distinguishing "bad signature" from
 *  "expired timestamp" in the response body (§8: "do not distinguish in
 *  the response body, avoid giving a replay attacker a timing oracle").
 *  The `reason` field IS available to the caller for server-side logging
 *  only (never echoed back to Slack). */
export function verifySlackSignature(input: VerifySlackSignatureInput): SlackSignatureVerificationResult {
  const { signingSecret, timestampHeader, signatureHeader, rawBody } = input;
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (!timestampHeader || !signatureHeader || signingSecret.length === 0) {
    return { valid: false, reason: "missing_headers" };
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) {
    return { valid: false, reason: "missing_headers" };
  }

  if (Math.abs(nowSeconds - timestamp) > SLACK_REPLAY_WINDOW_SECONDS) {
    return { valid: false, reason: "timestamp_out_of_range" };
  }

  const expected = computeSignature(signingSecret, timestampHeader, rawBody);
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(signatureHeader, "utf8");

  // timingSafeEqual throws on length mismatch — treat that as "not equal"
  // rather than letting it propagate (would otherwise leak a timing
  // signal / crash the handler on a malformed header).
  const matches = expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf);
  if (!matches) {
    return { valid: false, reason: "signature_mismatch" };
  }
  return { valid: true };
}
