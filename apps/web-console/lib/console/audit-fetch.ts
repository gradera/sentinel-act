// Client-side fetch helper for apps/web-console's own `/api/audit/**`
// routes (Spec 10, Observer mode). Mirrors `client-fetch.ts`'s
// `consoleFetch`/`DEV_REVIEWER` dev-header-bridge pattern exactly, but
// asserts the `compliance_head` role Spec 10's `OBSERVER_MODE_ROLES`
// requires — `client-fetch.ts`'s own `DEV_REVIEWER` is `compliance_officer`
// (Spec 09's Operator-mode identity), which `requireRole(OBSERVER_MODE_ROLES)`
// correctly rejects with a 403 on every `/api/audit/**` route. A second,
// separate dev identity constant is needed here rather than widening the
// existing one, since the two roles are deliberately disjoint
// (`OBSERVER_MODE_ROLES`'s own doc comment in `session.ts`).
//
// Same dev-only-bridge caveats as `client-fetch.ts`/`dev-session.ts` apply
// verbatim: this header bridge is inert (`isDevSessionBridgeEnabled()`
// returns false) outside development, so it is not a new trust boundary —
// the server, not this file, decides whether to honor these headers.
//
// This file lives outside `app/(observer)/audit/**` and `app/api/audit/**`,
// so Spec 10 FR-21's `no-restricted-imports` ESLint rule does not apply to
// it (it imports nothing from `@sentinel-act/graph-db` anyway).
const DEV_REVIEWER_ID_HEADER = "x-dev-reviewer-id";
const DEV_REVIEWER_ROLE_HEADER = "x-dev-reviewer-role";
const DEV_REVIEWER_NAME_HEADER = "x-dev-reviewer-name";
const DEV_REVIEWER_EMAIL_HEADER = "x-dev-reviewer-email";

/** Demo Compliance Head / auditor identity for local dev, distinct from
 *  `client-fetch.ts`'s `DEV_REVIEWER` (Operator mode). */
export const DEV_AUDITOR = {
  reviewerId: "auditor@example.com",
  role: "compliance_head" as const,
  name: "Compliance Head",
  email: "auditor@example.com"
};

/** `fetch` wrapper for this app's own `/api/audit/**` routes from client
 *  components (the export panel's create/poll/download calls). Always
 *  attaches the dev header-bridge identity (see top-of-file comment for
 *  why that's safe) and defaults to JSON request/response handling. */
export async function auditFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has(DEV_REVIEWER_ID_HEADER)) headers.set(DEV_REVIEWER_ID_HEADER, DEV_AUDITOR.reviewerId);
  if (!headers.has(DEV_REVIEWER_ROLE_HEADER)) headers.set(DEV_REVIEWER_ROLE_HEADER, DEV_AUDITOR.role);
  if (!headers.has(DEV_REVIEWER_NAME_HEADER)) headers.set(DEV_REVIEWER_NAME_HEADER, DEV_AUDITOR.name);
  if (!headers.has(DEV_REVIEWER_EMAIL_HEADER)) headers.set(DEV_REVIEWER_EMAIL_HEADER, DEV_AUDITOR.email);
  return fetch(path, { ...init, headers, cache: "no-store" });
}
