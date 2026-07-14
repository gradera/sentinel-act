// Client-side fetch helper for this app's own `/api/assistant/**` route
// (Spec 12 §5.6). Mirrors `audit-fetch.ts`/`client-fetch.ts`'s dev
// header-bridge pattern exactly — same caveats apply verbatim: this
// bridge is inert (`isDevSessionBridgeEnabled()` returns false) outside
// development, so it is not a new trust boundary (NFR-Security-2 is
// unaffected).
//
// Reuses `client-fetch.ts`'s existing `DEV_REVIEWER` identity rather than
// minting a third demo identity: `ASSISTANT_ROLES` (session.ts) is every
// real `ReviewerRole`, so `compliance_officer` (Operator mode's existing
// dev identity) is already permitted on this route — unlike
// `audit-fetch.ts`, which genuinely needed its own `DEV_AUDITOR` because
// `OBSERVER_MODE_ROLES`/`OPERATOR_MODE_ROLES` are disjoint.
import { DEV_REVIEWER } from "./client-fetch";

const DEV_REVIEWER_ID_HEADER = "x-dev-reviewer-id";
const DEV_REVIEWER_ROLE_HEADER = "x-dev-reviewer-role";
const DEV_REVIEWER_NAME_HEADER = "x-dev-reviewer-name";
const DEV_REVIEWER_EMAIL_HEADER = "x-dev-reviewer-email";

/** `fetch` wrapper for `POST /api/assistant/query` from client components.
 *  Always attaches the dev header-bridge identity and defaults to JSON
 *  request/response handling; callers pass a relative path. */
export async function assistantFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has(DEV_REVIEWER_ID_HEADER)) headers.set(DEV_REVIEWER_ID_HEADER, DEV_REVIEWER.reviewerId);
  if (!headers.has(DEV_REVIEWER_ROLE_HEADER)) headers.set(DEV_REVIEWER_ROLE_HEADER, DEV_REVIEWER.role);
  if (!headers.has(DEV_REVIEWER_NAME_HEADER)) headers.set(DEV_REVIEWER_NAME_HEADER, DEV_REVIEWER.name);
  if (!headers.has(DEV_REVIEWER_EMAIL_HEADER)) headers.set(DEV_REVIEWER_EMAIL_HEADER, DEV_REVIEWER.email);
  return fetch(path, { ...init, headers, cache: "no-store" });
}
