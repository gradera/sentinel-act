// Spec 15 §4.3 — the one normative `HealthCheckResponse` shape both apps'
// health endpoints conform to. Not published as a shared package (too
// small to justify one, per that spec's Task 7) — this is web-console's
// own local copy; apps/orchestrator carries an identical one in
// src/server/health-types.ts. Keep the two in sync by hand if this shape
// ever changes.
export interface HealthCheckResponse {
  status: "ok" | "degraded" | "down";
  service: "orchestrator" | "web-console";
  /** package.json's own `version` field, or a git SHA if version is
   *  unbumped (this app's package.json currently ships "0.0.0" — see
   *  resolveVersion() below for the fallback chain). */
  version: string;
  /** ISO datetime, response-generation time. */
  timestamp: string;
  /** Present on /api/health (this app's only health route serves both
   *  liveness and readiness — §5.3's note on Next.js having no separate
   *  distinction as commonly deployed). */
  checks?: Record<string, { status: "ok" | "down"; latencyMs?: number; error?: string }>;
}

const UNBUMPED_VERSION = "0.0.0";

/** Resolves HealthCheckResponse.version — see the identical function's
 *  doc comment in apps/orchestrator/src/server/health-types.ts for the
 *  full rationale (FR-39: this app's package.json version is
 *  permanently "0.0.0", so the real value always comes from the git-SHA
 *  fallback chain, never from a file read). */
export function resolveVersion(packageVersion: string = UNBUMPED_VERSION): string {
  if (packageVersion !== UNBUMPED_VERSION) {
    return packageVersion;
  }
  const sha =
    process.env.SENTINEL_GIT_SHA ??
    process.env.GITHUB_SHA ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.FLY_IMAGE_REF;
  if (sha) {
    return sha.slice(0, 12);
  }
  return "dev-unversioned";
}

/** Bounded-timeout wrapper for a single dependency check — identical
 *  contract to apps/orchestrator's timedCheck(). */
export async function timedCheck(
  name: string,
  fn: () => Promise<void>
): Promise<{ status: "ok" | "down"; latencyMs?: number; error?: string }> {
  const timeoutMs = Number(process.env.HEALTH_CHECK_TIMEOUT_MS ?? 2000);
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} check timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: "down",
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err)
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
