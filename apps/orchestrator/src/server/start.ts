// Minimal process entrypoint for the FR-24a HTTP server (createHttpServer,
// http-server.ts). Listens on PORT, defaulting to 4111 — the documented
// Mastra dev default (Spec 15 §4.1: `ORCHESTRATOR_BASE_URL` =
// `http://localhost:4111`).
//
// IMPORTANT: every route in http-server.ts calls
// `getOrchestratorRuntime()` (orchestrator.workflow.ts), which throws until
// `configureOrchestratorRuntime(...)` has been called with a real
// `graphWriter`/`monitoring`/`index`/`engine`/`auditLog` wiring. That
// runtime wiring (Neo4j driver, Spec 07's MonitoringAuditPort, the Mastra
// WorkflowEnginePort adapter, etc.) is out of this task's scope — it
// belongs to whatever boots the full Mastra app (this app's `mastra dev` /
// `mastra build` path, or a future `apps/orchestrator/src/server/runtime.ts`
// that composes the real adapters). Call `configureOrchestratorRuntime`
// before importing/starting this module in production use; for local
// exploration a test-double runtime (see
// apps/orchestrator/src/mastra/workflows/__tests__/orchestrator.workflow.test.ts
// for the shape of one) can be wired in ad hoc.
//
// How to run this file (no `tsx`/`ts-node` is a resolvable dependency of
// `apps/orchestrator` today — it exists only in the pnpm store as a
// devDependency of `packages/audit-ledger`/`packages/graph-db`, not
// hoisted here, and this task must not add a new dependency):
//   1. Compile then run the plain JS output (works today, zero new deps):
//        ./node_modules/.bin/tsc -p apps/orchestrator/tsconfig.json
//        node apps/orchestrator/dist/server/start.js
//   2. If `tsx` is later added as a devDependency of this package (matching
//      the convention already used by packages/audit-ledger and
//      packages/graph-db's own `migrate`/`seed` scripts):
//        tsx src/server/start.ts
//   Node's native `--experimental-strip-types` was tried and does NOT work
//   here out of the box: this codebase's relative imports use explicit
//   `.js` extensions (the correct ESM-with-TS-source convention) and
//   Node's type-stripping mode does not remap those to sibling `.ts` files
//   on disk, so it fails to resolve them without `tsx`/a bundler.
import { createHttpServer } from "./http-server.js";

const port = Number(process.env.PORT ?? 4111);

const server = createHttpServer();
server.listen(port, () => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", operation: "orchestrator-http-server-start", port }));
});
