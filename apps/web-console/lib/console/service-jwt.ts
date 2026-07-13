// Mints the service-to-service JWT apps/orchestrator's `assertServiceAuth`
// (apps/orchestrator/src/mastra/workflows/orchestrator.workflow.ts) and
// `verifyServiceJwt` (.../orchestrator.logic.ts) expect. This is the
// producer side of the exact HS256 scheme those two functions verify —
// read in full before touching this file:
//
//   - Token shape: `${headerB64}.${payloadB64}.${signatureB64}`, all
//     three segments base64url (no padding), matching
//     verifyServiceJwt's `token.split(".")` / `base64UrlDecode`.
//   - Signature: HMAC-SHA256 over the ASCII bytes of
//     `${headerB64}.${payloadB64}` (createHmac("sha256", secret)), same
//     as verifyServiceJwt's `expected` computation — no external JWT
//     library, `node:crypto` only, mirroring the verifier exactly.
//   - `exp` claim: verifyServiceJwt only checks `exp` when it is present
//     and is a `number` (`payload.exp * 1000 < Date.now()` fails the
//     token); this minter always sets one, short-lived, since this token
//     only needs to live for the duration of a single BFF -> Orchestrator
//     call.
//   - Secret: `SENTINEL_SERVICE_JWT_SECRET` — confirmed exact env var
//     name via assertServiceAuth's default parameter
//     (`secret = process.env.SENTINEL_SERVICE_JWT_SECRET`) and both
//     apps' .env.example files.
//
// Deliberately NOT importing apps/orchestrator's `verifyServiceJwt` to
// cross-check at runtime — see orchestrator-client.ts's doc comment for
// why apps/orchestrator cannot be imported from apps/web-console today.
// This file is therefore a hand-verified structural mirror, not a
// compiler-enforced one; keep it in lockstep with orchestrator.workflow.ts
// / orchestrator.logic.ts by hand if either changes.
import { createHmac } from "node:crypto";

const SERVICE_JWT_ENV_VAR = "SENTINEL_SERVICE_JWT_SECRET";

/** Short-lived on purpose (see doc comment above) — this token is minted
 *  fresh for every BFF -> Orchestrator call, never cached/reused across
 *  requests. 60s gives ample margin over realistic call latency
 *  (NFR-Perf-1/2's 500ms/800ms p95 budgets) without leaving a long-lived
 *  bearer token floating around if one were ever logged by accident. */
export const SERVICE_JWT_TTL_SECONDS = 60;

function base64UrlEncode(input: Buffer | string): string {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface ServiceJwtPayload {
  /** Identifies this token as issued by the web-console BFF — informational
   *  only, `verifyServiceJwt` does not check `iss`, but useful for audit
   *  logging on the orchestrator side if it's ever added there. */
  iss: "sentinel-web-console";
  iat: number; // seconds since epoch
  exp: number; // seconds since epoch — verifyServiceJwt checks this iff present
}

/** Pure, unit-testable core: given a secret and an explicit "now", builds
 *  and signs the token deterministically. No `process.env` access, no
 *  `Date.now()` call — see `mintServiceJwt` below for the env-reading /
 *  wall-clock-using wrapper real callers use. */
export function signServiceJwt(secret: string, nowSeconds: number, ttlSeconds: number = SERVICE_JWT_TTL_SECONDS): string {
  const header = { alg: "HS256", typ: "JWT" };
  const payload: ServiceJwtPayload = {
    iss: "sentinel-web-console",
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(`${headerB64}.${payloadB64}`).digest();
  const signatureB64 = base64UrlEncode(signature);

  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

/** Real entry point: reads `SENTINEL_SERVICE_JWT_SECRET` from
 *  `process.env` and the current wall clock, then delegates to the pure
 *  `signServiceJwt`. Throws (does not return an unsigned/empty token) if
 *  the secret is not configured — mirrors `assertServiceAuth`'s own
 *  fail-closed behavior ("SENTINEL_SERVICE_JWT_SECRET is not
 *  configured.") rather than silently minting a token no orchestrator
 *  instance could ever accept. */
export function mintServiceJwt(): string {
  const secret = process.env[SERVICE_JWT_ENV_VAR];
  if (!secret) {
    throw new Error(`${SERVICE_JWT_ENV_VAR} is not configured — cannot mint a service-to-service JWT.`);
  }
  return signServiceJwt(secret, Math.floor(Date.now() / 1000));
}

/** Formats a minted token as an `Authorization` header value — both
 *  `assertServiceAuth`'s `token = (authorization ?? "").replace(/^Bearer\s+/i, "")`
 *  and this helper agree on the "Bearer <token>" convention, but
 *  assertServiceAuth also tolerates the bare token with no prefix, so
 *  callers are free to send either; this is just the conventional form. */
export function toAuthorizationHeader(token: string): string {
  return `Bearer ${token}`;
}
