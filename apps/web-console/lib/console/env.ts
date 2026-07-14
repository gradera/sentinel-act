// Spec 15 §11 Task 11 / §8's "renamed env var" error-handling row: a
// small zod-based module validating required env vars at process
// startup, mirroring apps/orchestrator/src/server/env.ts's contract for
// this app.
//
// Scope note: `NEXTAUTH_SECRET`/`NEXTAUTH_URL` are deliberately NOT
// required here even though both are listed in .env.example — that
// file's own comment on `REVIEWER_SESSION_SECRET` says so explicitly:
// "NEXTAUTH_SECRET above (unused — next-auth is not an installed
// dependency of this app)". `REVIEWER_SESSION_SECRET` (the credential
// actually read by lib/console/session-jwt.ts) is required instead.
import { z } from "zod";

export const webConsoleEnvSchema = z.object({
  ORCHESTRATOR_BASE_URL: z.string().min(1, "ORCHESTRATOR_BASE_URL is required (BFF -> Orchestrator base URL, Spec 09)."),
  SENTINEL_SERVICE_JWT_SECRET: z
    .string()
    .min(1, "SENTINEL_SERVICE_JWT_SECRET is required (BFF <-> Orchestrator service auth, Spec 09/15)."),
  REVIEWER_SESSION_SECRET: z
    .string()
    .min(1, "REVIEWER_SESSION_SECRET is required (signs/verifies the sentinel_reviewer_session cookie, Spec 09)."),
  NEXT_PUBLIC_ENVIRONMENT_TIER: z.enum(["local", "staging", "production"], {
    message: 'NEXT_PUBLIC_ENVIRONMENT_TIER is required and must be one of "local", "staging", "production".'
  })
});

export type WebConsoleEnv = z.infer<typeof webConsoleEnvSchema>;

/** Thrown by `validateWebConsoleEnv` — a single, readable summary of
 *  every missing/invalid required env var. */
export class WebConsoleEnvValidationError extends Error {
  constructor(issues: string[]) {
    super(`Invalid web-console environment configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "WebConsoleEnvValidationError";
  }
}

/** Validates `env` (defaults to `process.env`) against the required-var
 *  schema above. Intended to be called once at process startup — see
 *  instrumentation.ts (Next.js's own startup hook) for where this app
 *  wires it in. */
export function validateWebConsoleEnv(env: NodeJS.ProcessEnv = process.env): WebConsoleEnv {
  const result = webConsoleEnvSchema.safeParse(env);
  if (!result.success) {
    // See apps/orchestrator/src/server/env.ts's identical fix for why the
    // field path is always prefixed rather than relying on the
    // validator's own message to name the field.
    const issues = result.error.issues.map((issue) => {
      const field = issue.path.join(".");
      return field ? `${field}: ${issue.message}` : issue.message;
    });
    throw new WebConsoleEnvValidationError(issues);
  }
  return result.data;
}
