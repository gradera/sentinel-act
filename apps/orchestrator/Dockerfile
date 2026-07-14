# Spec 15 §11 Task 9 / FR-23. Multi-stage build for apps/orchestrator.
#
# IMPORTANT — corrected against FR-23's original text (found while writing
# this file, see src/server/start.ts's header comment for the full
# writeup): the production entrypoint is NOT `mastra build`'s output.
# `src/mastra/index.ts` is still an explicit STUB (its own header comment:
# "STUB: wire to `new Mastra({ agents, workflows })`"), so a `mastra
# build`-produced image would not actually serve any of the real HTTP
# routes this app exposes (Spec 08 §6 FR-24a's hand-rolled node:http
# server in src/server/http-server.ts — review-gate, claim, resume,
# healthz, readyz, the Slack routes). That server is started by
# src/server/start.ts via `tsx` (a real dependency of this package as of
# this task), which is what this image actually runs.
#
# NOTE (sandbox limitation, same as docker-compose.yml): authored and
# syntax-reviewed in an environment with no docker binary/socket
# available — could not be build-tested here. Treat a build failure as a
# real bug, not a flake, per this repo's own established convention for
# this exact gap (see docker-compose.yml's and the graph-db/audit-ledger
# Testcontainers integration tests' identical caveat).

FROM node:20-slim AS base
RUN corepack enable

# ---------------------------------------------------------------------------
# deps: install the full pnpm workspace (workspace:* packages need
# sibling packages present at install time; there is no supported way to
# install just apps/orchestrator's slice of a pnpm workspace without
# `pnpm deploy`, which this task deliberately avoids to keep the
# Dockerfile close to the plain `pnpm install --frozen-lockfile` every
# contributor already runs locally, per §11 Task 9's "illustrative
# skeleton, not a fully-tuned production image" framing, Spec 15 §1's own
# non-goal).
# ---------------------------------------------------------------------------
FROM base AS deps
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/orchestrator/package.json apps/orchestrator/package.json
COPY apps/web-console/package.json apps/web-console/package.json
COPY packages packages
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# runtime: copy source + installed node_modules, run directly via tsx (no
# separate compile step — see header comment above for why plain
# `tsc`+`node` does not work against this monorepo's workspace packages
# today). Non-root user per FR-23.
# ---------------------------------------------------------------------------
FROM base AS runtime
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=deps /repo /repo
COPY apps/orchestrator apps/orchestrator
COPY packages packages

RUN addgroup --system --gid 1001 sentinel && \
    adduser --system --uid 1001 --gid 1001 sentinel
USER sentinel

WORKDIR /repo/apps/orchestrator
# Confirmed against src/server/start.ts: PORT defaults to 4111 (Mastra's
# own dev-server default, §4.1's ORCHESTRATOR_BASE_URL note).
EXPOSE 4111

CMD ["pnpm", "start"]
