// Client-side fetch helper for apps/web-console's own BFF routes
// (app/api/console/**). Spec 09's real auth boundary is the signed
// `sentinel_reviewer_session` cookie (session.ts / session-jwt.ts); no
// login screen exists yet in this hackathon build, so — exactly like the
// server-side route handlers already fall back to `dev-session.ts`'s
// `x-dev-reviewer-id`/`x-dev-reviewer-role` header bridge when
// `NODE_ENV !== "production"` — every BROWSER call this app's own client
// components make to `/api/console/**` attaches the same headers. This is
// NOT a new trust boundary: `dev-session.ts` already documents at length
// that this bridge is inert (`isDevSessionBridgeEnabled()` returns false)
// outside development, so these headers are inert in production too, and
// NFR-Security-2 ("never trust a client-supplied reviewerId") is
// unaffected — the server, not this file, decides whether to honor them.
//
// Kept as a single shared helper (rather than each client component
// hand-rolling headers) so there is exactly one place to delete this dev
// bridge from once a real login flow exists (see dev-session.ts's own
// TODO).
const DEV_REVIEWER_ID_HEADER = "x-dev-reviewer-id";
const DEV_REVIEWER_ROLE_HEADER = "x-dev-reviewer-role";
const DEV_REVIEWER_NAME_HEADER = "x-dev-reviewer-name";
const DEV_REVIEWER_EMAIL_HEADER = "x-dev-reviewer-email";

/** Matches the demo reviewer identities already used in
 *  app/(dev)/dev/components/page.tsx's static HumanReview fixtures
 *  (`j.rao@example.com`), so manual verification against those demo
 *  screens and against this wired-up queue/detail flow line up. */
export const DEV_REVIEWER = {
  reviewerId: "j.rao@example.com",
  role: "compliance_officer" as const,
  name: "J. Rao",
  email: "j.rao@example.com"
};

/** `fetch` wrapper for this app's own `/api/console/**` routes from
 *  client components. Always attaches the dev header-bridge identity (see
 *  top-of-file comment for why that's safe) and defaults to JSON
 *  request/response handling; callers pass a relative path
 *  (`"/api/console/queue?..."`). */
export async function consoleFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has(DEV_REVIEWER_ID_HEADER)) headers.set(DEV_REVIEWER_ID_HEADER, DEV_REVIEWER.reviewerId);
  if (!headers.has(DEV_REVIEWER_ROLE_HEADER)) headers.set(DEV_REVIEWER_ROLE_HEADER, DEV_REVIEWER.role);
  if (!headers.has(DEV_REVIEWER_NAME_HEADER)) headers.set(DEV_REVIEWER_NAME_HEADER, DEV_REVIEWER.name);
  if (!headers.has(DEV_REVIEWER_EMAIL_HEADER)) headers.set(DEV_REVIEWER_EMAIL_HEADER, DEV_REVIEWER.email);
  return fetch(path, { ...init, headers, cache: "no-store" });
}
