// Spec 15 §11 Task 11 / §8's "renamed env var" error-handling row: a
// small zod-based module validating required env vars at process
// startup, so a missing/renamed variable fails fast with one clear
// error message instead of surfacing later as an opaque "undefined" bug
// deep inside a Neo4j/Postgres driver call (e.g. a stale `.env` still
// carrying the old `GRAPH_DB_URL` name after Spec 15's FR-1 rename).
//
// Scope note: only variables this process cannot run *any* meaningful
// route without are required here. Several §4.1 variables are
// intentionally NOT required — Slack (SLACK_BOT_TOKEN/SLACK_SIGNING_SECRET)
// and GRC/Ticketing (TICKETING_WEBHOOK_URL/SECRET) are already, elsewhere
// in this codebase, treated as optional supplementary surfaces that
// degrade gracefully when unconfigured (see slack/app.ts's
// SlackConfigError and start.ts's "SLA reminder scheduler not started"
// log line) — requiring them here would contradict that existing,
// deliberate design and break every deployment that hasn't set up Slack/
// GRC yet.
import { z } from "zod";

export const orchestratorEnvSchema = z.object({
  SENTINEL_NEO4J_URI: z.string().min(1, "SENTINEL_NEO4J_URI is required (Neo4j connection URI, Spec 01)."),
  SENTINEL_NEO4J_USER: z.string().min(1, "SENTINEL_NEO4J_USER is required."),
  SENTINEL_NEO4J_PASSWORD: z.string().min(1, "SENTINEL_NEO4J_PASSWORD is required."),
  SENTINEL_AUDIT_LEDGER_DATABASE_URL: z
    .string()
    .min(1, "SENTINEL_AUDIT_LEDGER_DATABASE_URL is required (Postgres connection string, Spec 07)."),
  SENTINEL_SERVICE_JWT_SECRET: z
    .string()
    .min(1, "SENTINEL_SERVICE_JWT_SECRET is required (BFF <-> Orchestrator service auth, Spec 09/15)."),
  MODEL_PROVIDER_API_KEY: z.string().min(1, "MODEL_PROVIDER_API_KEY is required (Specs 03/04/06's model calls).")
});

export type OrchestratorEnv = z.infer<typeof orchestratorEnvSchema>;

/** Thrown by `validateOrchestratorEnv` — a single, readable summary of
 *  every missing/invalid required env var, never a raw ZodError (whose
 *  default message is far less operator-friendly at a glance). */
export class OrchestratorEnvValidationError extends Error {
  constructor(issues: string[]) {
    super(`Invalid orchestrator environment configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "OrchestratorEnvValidationError";
  }
}

/** Validates `env` (defaults to `process.env`) against the required-var
 *  schema above. Call once at process startup (start.ts) — intentionally
 *  synchronous and side-effect-free otherwise, so it is also cheap and
 *  safe to call from a unit test with a hand-built env object. */
export function validateOrchestratorEnv(env: NodeJS.ProcessEnv = process.env): OrchestratorEnv {
  const result = orchestratorEnvSchema.safeParse(env);
  if (!result.success) {
    // Always prefix with the field path — zod v4's default message for a
    // missing/undefined value ("Invalid input: expected string, received
    // undefined") does not itself name the field, so the custom `.min()`
    // messages above only cover the "present but empty string" case, not
    // "absent entirely". Prefixing with `issue.path` makes both cases
    // equally clear without depending on which validator produced the
    // message.
    const issues = result.error.issues.map((issue) => {
      const field = issue.path.join(".");
      return field ? `${field}: ${issue.message}` : issue.message;
    });
    throw new OrchestratorEnvValidationError(issues);
  }
  return result.data;
}
