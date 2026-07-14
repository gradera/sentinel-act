// Spec 15 §4.3 — the one normative `HealthCheckResponse` shape both apps'
// health endpoints conform to. Not published as a shared package (too
// small to justify one, per that spec's Task 7) — this is the
// orchestrator's own local copy; apps/web-console carries an identical
// one in lib/console/health-types.ts. Keep the two in sync by hand if
// this shape ever changes.
export interface HealthCheckResponse {
  status: "ok" | "degraded" | "down";
  service: "orchestrator" | "web-console";
  /** package.json's own `version` field, or a git SHA if version is
   *  unbumped (both this app's and web-console's package.json currently
   *  ship "0.0.0" — see resolveVersion() below for the fallback chain). */
  version: string;
  /** ISO datetime, response-generation time. */
  timestamp: string;
  /** Present on /readyz (and /api/health) only — /healthz never touches
   *  a dependency (FR-30/FR-31/FR-33). */
  checks?: Record<string, { status: "ok" | "down"; latencyMs?: number; error?: string }>;
}

const UNBUMPED_VERSION = "0.0.0";

/** Resolves HealthCheckResponse.version per §4.3's comment: the real
 *  package.json version once this app starts getting real releases, or a
 *  short git SHA in the meantime. `packageVersion` defaults to this
 *  app's permanently-unbumped `"0.0.0"` (FR-39: `apps/orchestrator` and
 *  `apps/web-console` are `"private": true`, never versioned via
 *  Changesets/semver — their release identity IS the deployed git SHA) —
 *  callers only need to pass a real value if that ever changes. Every
 *  deploy target this spec recommends (Vercel, Fly.io, GitHub Actions)
 *  makes *some* commit-SHA env var available; `SENTINEL_GIT_SHA` is this
 *  repo's own platform-neutral name for it (§11 Task 6's deploy.yml sets
 *  it explicitly from `github.sha` before deploying), checked first so
 *  the same code works the same way on every target rather than
 *  special-casing each platform's own env var name here. Deliberately
 *  does NOT read `package.json` off disk — `apps/orchestrator`'s
 *  `tsconfig.json` scopes `rootDir`/`include` to `src` only, so a
 *  relative import of the app's own `package.json` (one level above
 *  `src`) would fail the build; since FR-39 already fixes this app's
 *  version at "0.0.0" forever, there is nothing on disk worth reading. */
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

/** Bounded-timeout wrapper for a single dependency check (FR-34:
 *  `HEALTH_CHECK_TIMEOUT_MS`, default 2000ms). Never throws — always
 *  resolves to a `{status, latencyMs, error}` triple so callers can
 *  build the `checks` map uniformly regardless of which dependency
 *  timed out vs. errored vs. succeeded. */
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
