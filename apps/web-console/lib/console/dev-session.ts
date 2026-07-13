// ***** DEV-ONLY BRIDGE — NOT A SECURITY BOUNDARY *****
//
// Spec 09 Task 10 needs "session/auth plumbing" but this hackathon build
// has no login UI, no SSO/OIDC provisioning (explicitly out of scope per
// Spec 09 §2's Non-Goals: "Not responsible for identity provisioning"),
// and no auth library installed (`next-auth` is not a dependency of
// apps/web-console — confirmed via package.json — and this task may not
// add one). Something still has to answer "who is the calling reviewer"
// for local development and for this stage's own manual verification.
//
// This file is that something, and it is exactly as trustworthy as
// whatever sets these headers — which today is a developer's curl command
// or browser extension, not a verified identity provider. It reads
// `x-dev-reviewer-id` / `x-dev-reviewer-role` / `x-dev-reviewer-name` /
// `x-dev-reviewer-email` request headers ONLY when `NODE_ENV !== "production"`,
// so this bridge cannot activate in a production deployment even if a
// caller sends these headers (session.ts's real cookie path is checked
// first regardless of environment; see that file).
//
// NFR-Security-2 ("never trust a client-supplied reviewerId") still holds:
// this bridge is a REPLACEMENT for a login flow (identity is asserted by
// whatever sets these headers, exactly like a session cookie would be),
// not a way for browser-facing route handlers to accept a `reviewerId` in
// a POST body — every route handler in this app still reads `reviewerId`
// exclusively from `getReviewerSession(request).reviewerId`, never from
// `request.json()`. The distinction that matters is "does the BFF derive
// identity from a mechanism outside the request payload the caller
// controls" (yes, here — headers set by the dev's own tooling, not by
// in-band JSON the route handler's own validation code reads), not
// "is this mechanism as strong as a real login" (it isn't, and this
// comment says so on every line).
//
// TODO(spec-09-later-stage): replace with a real login screen that mints
// the signed cookie session-jwt.ts already supports (`signReviewerSessionToken`
// / `REVIEWER_SESSION_COOKIE_NAME`) — this file should be deleted, not
// extended, once that exists.
import type { ReviewerRole, ReviewerSession } from "./types";

const DEV_REVIEWER_ID_HEADER = "x-dev-reviewer-id";
const DEV_REVIEWER_ROLE_HEADER = "x-dev-reviewer-role";
const DEV_REVIEWER_NAME_HEADER = "x-dev-reviewer-name";
const DEV_REVIEWER_EMAIL_HEADER = "x-dev-reviewer-email";

const VALID_ROLES: ReadonlySet<ReviewerRole> = new Set([
  "compliance_officer",
  "senior_compliance_officer",
  "backup_reviewer",
  "compliance_head"
]);

function isValidRole(value: string | null): value is ReviewerRole {
  return value !== null && VALID_ROLES.has(value as ReviewerRole);
}

/** `true` only outside production — the single gate this entire bridge
 *  depends on. Exported (not inlined at each call site) so there is
 *  exactly one place to audit for the "does this ever run in prod"
 *  question. */
export function isDevSessionBridgeEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}

/** Reads the four `x-dev-reviewer-*` headers off an incoming request and
 *  builds a `ReviewerSession`, or returns `null` if the bridge is disabled
 *  (production) or the required headers are missing/malformed. Accepts a
 *  narrow `{ headers: { get(name): string | null } }` shape (both
 *  `Request`/`NextRequest` satisfy this) so this file has no framework
 *  import of its own. */
export function readDevReviewerSession(request: { headers: { get(name: string): string | null } }): ReviewerSession | null {
  if (!isDevSessionBridgeEnabled()) {
    return null;
  }

  const reviewerId = request.headers.get(DEV_REVIEWER_ID_HEADER);
  const roleRaw = request.headers.get(DEV_REVIEWER_ROLE_HEADER);
  if (!reviewerId || reviewerId.trim().length === 0 || !isValidRole(roleRaw)) {
    return null;
  }

  const name = request.headers.get(DEV_REVIEWER_NAME_HEADER) ?? reviewerId;
  const email = request.headers.get(DEV_REVIEWER_EMAIL_HEADER) ?? `${reviewerId}@dev.local`;

  return { reviewerId, name, email, role: roleRaw };
}
