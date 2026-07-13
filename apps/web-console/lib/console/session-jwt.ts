// Signs/verifies the reviewer-session cookie token this app's (not yet
// built) login flow will eventually mint. Deliberately structured just
// like service-jwt.ts (same HS256-over-node:crypto, no external JWT
// library) but with a SEPARATE secret and a different payload — see
// session.ts's top-of-file doc comment for why `SENTINEL_SERVICE_JWT_SECRET`
// (the BFF -> Orchestrator service credential) must never be reused here:
// this token authenticates an end-user's browser to this app, a completely
// different trust boundary than "is this caller apps/web-console's BFF."
//
// `REVIEWER_SESSION_SECRET` is a NEW env var this stage adds (see
// apps/web-console/.env.example) — `NEXTAUTH_SECRET` already existed in
// that file (docs/specs/15-ci-cd-environment-setup.md §4.1) but next-auth
// itself is not an installed dependency of this app (confirmed via
// apps/web-console/package.json — no `next-auth` entry, and this task may
// not add one), so naming this app's own hand-rolled session secret after
// a library that isn't wired in would be misleading. `REVIEWER_SESSION_SECRET`
// names what it actually is.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ReviewerRole } from "./types";

const REVIEWER_SESSION_SECRET_ENV_VAR = "REVIEWER_SESSION_SECRET";

/** 8 hours — long enough for a reviewer's working session, short enough
 *  that a stolen cookie has a bounded lifetime. Unconfirmed placeholder,
 *  same status as every other threshold constant in this codebase
 *  (sla.ts's `SLA_DUE_SOON_WINDOW_HOURS`, risk-score.scorer.ts's tier
 *  thresholds) — easy to change once a real session policy exists. */
export const REVIEWER_SESSION_TTL_SECONDS = 8 * 60 * 60;

export const REVIEWER_SESSION_COOKIE_NAME = "sentinel_reviewer_session";

export interface ReviewerSessionTokenPayload {
  reviewerId: string;
  name: string;
  email: string;
  role: ReviewerRole;
  iat: number;
  exp: number;
}

function base64UrlEncode(input: Buffer | string): string {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(segment: string): Buffer {
  return Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Pure, unit-testable core — no `process.env`/`Date.now()` access. Mirrors
 *  service-jwt.ts's `signServiceJwt` shape exactly (header.payload.signature,
 *  all base64url, HMAC-SHA256 over the ASCII header.payload bytes). */
export function signReviewerSessionToken(
  secret: string,
  claims: Omit<ReviewerSessionTokenPayload, "iat" | "exp">,
  nowSeconds: number,
  ttlSeconds: number = REVIEWER_SESSION_TTL_SECONDS
): string {
  const header = { alg: "HS256", typ: "JWT" };
  const payload: ReviewerSessionTokenPayload = { ...claims, iat: nowSeconds, exp: nowSeconds + ttlSeconds };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(`${headerB64}.${payloadB64}`).digest();
  return `${headerB64}.${payloadB64}.${base64UrlEncode(signature)}`;
}

/** Verifies signature + `exp`. Returns the decoded payload on success, or
 *  `null` on any failure (malformed token, bad signature, expired) —
 *  never throws, mirroring orchestrator.logic.ts's `verifyServiceJwt`. */
export function verifyReviewerSessionToken(token: string, secret: string): ReviewerSessionTokenPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }
    const [headerB64, payloadB64, signatureB64] = parts;
    const expected = createHmac("sha256", secret).update(`${headerB64}.${payloadB64}`).digest();
    const provided = base64UrlDecode(signatureB64);
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      return null;
    }
    const payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8")) as ReviewerSessionTokenPayload;
    if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) {
      return null;
    }
    if (typeof payload.reviewerId !== "string" || typeof payload.role !== "string") {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/** Reads `REVIEWER_SESSION_SECRET` from `process.env`. Returns `undefined`
 *  (does NOT throw) when unset — unlike `mintServiceJwt`'s fail-closed
 *  behavior, an unset session secret in dev is a normal, expected state
 *  (no login flow exists yet; `dev-session.ts`'s header bridge is how this
 *  app authenticates reviewers until one is built) — callers decide what
 *  "no secret configured" means for them. */
export function getReviewerSessionSecret(): string | undefined {
  return process.env[REVIEWER_SESSION_SECRET_ENV_VAR];
}
