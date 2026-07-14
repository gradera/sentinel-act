// Spec 15 §5.3/FR-35 `GET /api/health`. Deliberately has NO session/role
// guard (FR-36: health checks must be callable by an unauthenticated
// platform load balancer) — this is the one route in app/api/** that must
// NOT call requireSession()/requireRole() from lib/console/session.ts.
//
// Pings ORCHESTRATOR_BASE_URL + "/healthz" (not "/readyz" — per §5.3's
// rationale: this app only needs to know the orchestrator process is up,
// not re-verify its database dependencies transitively; Observer-mode
// audit lookups against already-fetched data remain useful even if the
// orchestrator is briefly unreachable, hence "degraded" rather than
// "down" on failure below).
import { NextResponse } from "next/server";
import { resolveVersion, timedCheck, type HealthCheckResponse } from "@/lib/console/health-types";

const VERSION = resolveVersion();

async function pingOrchestrator(): Promise<void> {
  const base = process.env.ORCHESTRATOR_BASE_URL;
  if (!base) {
    throw new Error("ORCHESTRATOR_BASE_URL is not configured.");
  }
  const res = await fetch(`${base.replace(/\/+$/, "")}/healthz`, { method: "GET", cache: "no-store" });
  if (!res.ok) {
    throw new Error(`orchestrator /healthz responded ${res.status}`);
  }
}

export async function GET(): Promise<NextResponse<HealthCheckResponse>> {
  const orchestrator = await timedCheck("orchestrator", pingOrchestrator);
  const ok = orchestrator.status === "ok";
  const body: HealthCheckResponse = {
    status: ok ? "ok" : "degraded",
    service: "web-console",
    version: VERSION,
    timestamp: new Date().toISOString(),
    checks: { orchestrator }
  };
  return NextResponse.json(body, { status: ok ? 200 : 503 });
}
