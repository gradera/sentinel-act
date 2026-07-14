// Spec 09 Task 10 ("Session/auth plumbing... role-based route guards").
//
// ***** WHAT IS AND ISN'T A REAL SECURITY BOUNDARY HERE — READ BEFORE USE *****
//
// `getReviewerSession` has two possible sources, tried in order:
//
//   1. A signed `sentinel_reviewer_session` cookie, verified with
//      `REVIEWER_SESSION_SECRET` (session-jwt.ts). THIS is the real
//      boundary: if a login flow (not built in this stage — no
//      SSO/OIDC provisioning is in scope per Spec 09 §2) ever mints this
//      cookie, its signature is checked server-side before any claim
//      inside it is trusted. Nothing in this app currently sets this
//      cookie, so in practice this path returns nothing today — it exists
//      so the write routes below (claim/decisions) already have a real
//      mechanism to switch to the moment a login screen exists, without
//      another round of route-handler changes.
//   2. `dev-session.ts`'s `x-dev-reviewer-id`/`x-dev-reviewer-role`
//      header bridge — ONLY consulted when `NODE_ENV !== "production"`
//      (see that file's own extensive doc comment for why this is
//      explicitly NOT a security boundary, just a local-dev convenience).
//
// `REVIEWER_SESSION_SECRET` is intentionally NOT `SENTINEL_SERVICE_JWT_SECRET`
// — that secret authenticates apps/web-console's BFF to apps/orchestrator
// (service-to-service); this one would authenticate an end user's browser
// to apps/web-console (user-to-BFF). Conflating them would mean a token
// meant for one trust boundary could be replayed across the other.
//
// NFR-Security-2's hard invariant — "never trust a client-supplied
// reviewerId" — is enforced by construction here: every route handler in
// this app calls `getReviewerSession(request)` and reads `.reviewerId` off
// the RESULT, never off `request.json()`/`request.nextUrl.searchParams`.
// There is no code path in this file that echoes an untrusted request
// value back out as a `reviewerId`.
import type { NextRequest } from "next/server";
import { readDevReviewerSession } from "./dev-session";
import { REVIEWER_SESSION_COOKIE_NAME, getReviewerSessionSecret, verifyReviewerSessionToken } from "./session-jwt";
import type { ReviewerRole, ReviewerSession } from "./types";

/** Thrown by `requireSession` when no session was resolved at all — route
 *  handlers map this to `401`. */
export class UnauthorizedError extends Error {
  constructor(message = "No reviewer session found on this request.") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** Thrown by `requireRole` when a session exists but its role isn't in the
 *  allowed set for the route (FR-32: `compliance_head` 403 on writes).
 *  `code` defaults to a generic value; route handlers may pass a more
 *  specific one (matching Spec 09 §8's error table) when constructing the
 *  JSON error body. */
export class ForbiddenError extends Error {
  public readonly code: string;
  constructor(message: string, code = "FORBIDDEN") {
    super(message);
    this.name = "ForbiddenError";
    this.code = code;
  }
}

/** Resolves the calling reviewer's session for a Next.js Route Handler
 *  request. Returns `null` (never throws) when no session can be
 *  resolved — callers that require a session should call `requireSession`
 *  on the result rather than assume non-null. */
export async function getReviewerSession(request: NextRequest): Promise<ReviewerSession | null> {
  const cookieToken = request.cookies.get(REVIEWER_SESSION_COOKIE_NAME)?.value;
  const secret = getReviewerSessionSecret();
  if (cookieToken && secret) {
    const payload = verifyReviewerSessionToken(cookieToken, secret);
    if (payload) {
      return { reviewerId: payload.reviewerId, name: payload.name, email: payload.email, role: payload.role };
    }
  }

  // Dev-only bridge (no-op in production) — see dev-session.ts.
  return readDevReviewerSession(request);
}

/** Narrows `ReviewerSession | null` to `ReviewerSession`, throwing
 *  `UnauthorizedError` (-> 401) otherwise. Route handlers should call this
 *  immediately after `getReviewerSession` before doing anything else. */
export function requireSession(session: ReviewerSession | null): ReviewerSession {
  if (!session) {
    throw new UnauthorizedError();
  }
  return session;
}

/** Throws `ForbiddenError` (-> 403) unless `session.role` is in
 *  `allowedRoles`. Every write route in this app (claim, decisions) MUST
 *  call this before making any Orchestrator call — per FR-32/§8's last
 *  row, `compliance_head` (read-only, Observer mode) gets 403 on every
 *  Operator-mode write route, checked at the session-role layer, before
 *  any Orchestrator call is made. */
export function requireRole(session: ReviewerSession, allowedRoles: readonly ReviewerRole[], code = "FORBIDDEN"): void {
  if (!allowedRoles.includes(session.role)) {
    throw new ForbiddenError(
      `reviewer role "${session.role}" is not permitted on this route (allowed: ${allowedRoles.join(", ")}).`,
      code
    );
  }
}

/** Spec 09 §5.1/§6 FR-8: `compliance_head` gets 403 on EVERY Operator-mode
 *  route in this app, not just the write routes — `GET /api/console/queue`
 *  ("compliance_head gets 403 here; use Spec 10's read-only endpoint
 *  instead") and `GET /api/console/items/:id` ("401 / 403 (same as
 *  above)") are explicit about this, and FR-32/§8's last row covers the
 *  write routes (claim, decisions). So this one constant — "every
 *  non-compliance_head role" — is the allowed-role set for all four BFF
 *  routes this stage builds, not a write-specific list. `backup_reviewer`
 *  is included per §4's own doc comment ("appears only on SLA breach
 *  reassignment") — a backup reviewer who has been reassigned an item must
 *  be able to read and act on it. */
export const OPERATOR_MODE_ROLES: readonly ReviewerRole[] = ["compliance_officer", "senior_compliance_officer", "backup_reviewer"];

/** Spec 10 §1/§7 (NFR-5's assumed `requireRole` boundary): role guard for
 *  every route under `app/api/audit/**` (Observer mode / Compliance
 *  Register Export). Spec 10 §1 opens with "This unit is the Compliance
 *  Head / auditor's entire surface" (singular persona), and Spec 09 FR-8's
 *  own doc comment on `OPERATOR_MODE_ROLES` above is explicit that the
 *  split is symmetric: "`GET /api/console/queue` (`compliance_head` gets
 *  403 here; use Spec 10's read-only endpoint instead)" — i.e.
 *  `compliance_head` is redirected to THIS route tree specifically,
 *  not merely "also allowed" alongside it. Neither spec's text
 *  affirmatively states whether `compliance_officer`/
 *  `senior_compliance_officer`/`backup_reviewer` may ALSO view this
 *  read-only surface (nothing here would be unsafe if they could — the
 *  FR-11a guard inside AuditQueryService already hides an unresolved
 *  Tier C/ESCALATE maker decision from every caller regardless of role),
 *  but absent an explicit "also allowed" statement, this is kept
 *  `compliance_head`-exclusive: the two mode role-sets are disjoint,
 *  mirroring the disjoint-by-design read of FR-8. If a future spec
 *  explicitly wants Operator-mode roles to read this screen too (e.g. a
 *  reviewer checking historical context on their own decisions), widen
 *  this constant — do not special-case it deeper in each route handler. */
export const OBSERVER_MODE_ROLES: readonly ReviewerRole[] = ["compliance_head"];

/** Spec 12 NFR-9: role guard for `POST /api/assistant/query`. The kickoff
 *  doc's own illustrative role list (`["operator","observer","admin"]`)
 *  doesn't exist in this codebase — `ReviewerRole` is the real four-value
 *  union (`compliance_officer`, `senior_compliance_officer`,
 *  `backup_reviewer`, `compliance_head`). The Conversational Assistant is a
 *  read-only aid over the same Regulatory Knowledge Graph both Operator
 *  mode (Spec 09) and Observer mode (Spec 10) already read from — nothing
 *  in Spec 12's text scopes it to one persona over the other, and
 *  read-only enforcement is already guaranteed by three independent layers
 *  below the route (FR-21/FR-22/FR-23), not by narrowing who may ask a
 *  question. So this is every real role, i.e. `OPERATOR_MODE_ROLES` union
 *  `OBSERVER_MODE_ROLES` — not a new, independently-drifting list. */
export const ASSISTANT_ROLES: readonly ReviewerRole[] = [...OPERATOR_MODE_ROLES, ...OBSERVER_MODE_ROLES];
