# Sentinel Act

Agentic regulatory compliance for SEBI-regulated intermediaries. Reads SEBI
circulars, turns them into structured, machine-actionable Obligations and
ProcessTasks, and routes every proposed change through tiered human review
(Tier A auto-commit, Tier B single reviewer, Tier C maker-checker) before it
becomes an operational instruction. Built for the SEBI Securities Market
TechSprint, GFF 2026, Problem Statement 2 (Agentic Compliance), by Team
Gradera Sentinels.

## Layout

- `apps/orchestrator` — Mastra backend: the deterministic Workflow
  Orchestrator and the five fanned-out agents (Obligation Extraction,
  Grounding and Verification, Mapping and Risk Scoring, Change and Delta,
  Monitoring and Audit), plus the Regulatory Watch and Ingestion agent that
  triggers the workflow. Observability is the Mastra Studio view directly —
  no separate observability app.
- `apps/web-console` — Next.js + shadcn/ui governance console. Route groups
  mirror the framework's Observer / Operator control modalities; Builder
  mode is out of scope for this build.
- `packages/ui` — shared shadcn/ui component workspace (`@sentinel-act/ui`),
  including governance-specific components (`RiskTierBadge`,
  `ConfidenceBadge`, `LineageBreadcrumb`) that implement the Trust Gradient
  and Progressive Disclosure sections of the design framework.
- `packages/graph-schema` — TypeScript types for the bitemporal Regulatory
  Knowledge Graph (7 node types, 7 edge types), shared by the orchestrator
  and the web console.
- `packages/config` — shared ESLint and TypeScript configs.
- `docs/` — architecture diagrams (PNG + drawio + walkthrough), the
  Knowledge Graph schema, and the submission documents.
- `ux/` — the UX brief for human governance, the Gradera UX design
  framework this build follows, and a home for Figma exports.

## Getting started

```bash
pnpm install
pnpm dev
```

`apps/orchestrator`'s agents and workflow are currently stubs — the module
shapes and responsibilities are final, but the Mastra API calls inside them
(`Agent`, `createWorkflow`, suspend/resume) need to be wired up and verified
against Mastra's current docs before this actually runs an end-to-end
extraction.
