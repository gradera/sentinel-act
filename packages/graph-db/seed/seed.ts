#!/usr/bin/env node
// Seed CLI (spec §5.9, FR-16–FR-19). Usage:
//   pnpm --filter @sentinel-act/graph-db seed --scenario=cuspa-pre
//   pnpm --filter @sentinel-act/graph-db seed --scenario=cuspa-post
//   pnpm --filter @sentinel-act/graph-db seed --scenario=dev-sample
//   pnpm --filter @sentinel-act/graph-db seed --reset
//   pnpm --filter @sentinel-act/graph-db seed --reset --scenario=cuspa-pre
//
// Every scenario is applied through the real GraphWriter.commitProposal
// path (no bespoke seed-only Cypher) using a fixed proposalId per fixture,
// so re-running the same scenario twice is a safe no-op (FR-15 idempotency
// marker) — this is also how FR-19's "no duplicate nodes on re-seed"
// guarantee is actually implemented, not a separate mechanism.
import type { Driver } from "neo4j-driver";
import type { CommitPlan } from "../src/types.js";
import { getDriver, verifyConnectivity, closeDriver, getSingletonDatabase } from "../src/driver.js";
import { GraphWriter } from "../src/commit/graph-writer.js";
import { buildCuspaPreAmendmentPlan } from "./fixtures/cuspa-pre-amendment.js";
import { buildCuspaPostAmendmentPlan } from "./fixtures/cuspa-post-amendment.js";
import { buildDevSampleSetPlan } from "./fixtures/dev-sample-set.js";

/** FR-16: refuse --reset / --scenario=* writes against anything that
 *  looks like an AuraDB production host, unless explicitly overridden. */
const AURA_HOST_PATTERN = /\.databases\.neo4j\.io/i;

const SCENARIOS: Record<string, () => CommitPlan> = {
  "cuspa-pre": buildCuspaPreAmendmentPlan,
  "cuspa-post": buildCuspaPostAmendmentPlan,
  "dev-sample": buildDevSampleSetPlan
};

interface ParsedArgs {
  scenario?: string;
  reset: boolean;
  iUnderstandThisIsNotLocal: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { reset: false, iUnderstandThisIsNotLocal: false };
  for (const arg of argv) {
    if (arg === "--reset") {
      args.reset = true;
    } else if (arg === "--i-understand-this-is-not-local") {
      args.iUnderstandThisIsNotLocal = true;
    } else if (arg.startsWith("--scenario=")) {
      args.scenario = arg.slice("--scenario=".length);
    } else {
      throw new Error(`Unrecognized argument: "${arg}". Supported: --scenario=<name>, --reset, --i-understand-this-is-not-local.`);
    }
  }
  return args;
}

export function assertSafeToWrite(uri: string, acknowledged: boolean): void {
  if (AURA_HOST_PATTERN.test(uri) && !acknowledged) {
    throw new Error(
      `Refusing to run against what looks like an Aura production host ("${uri}"). ` +
        "Pass --i-understand-this-is-not-local to override if this is genuinely intentional (FR-16)."
    );
  }
}

async function resetDatabase(driver: Driver, database: string): Promise<void> {
  const session = driver.session({ database });
  try {
    await session.executeWrite((tx) => tx.run("MATCH (n) DETACH DELETE n"));
  } finally {
    await session.close();
  }
}

/** Reports "already present" vs "newly created" on stdout per the §8
 *  error-handling table's "Seed script re-run against an already-seeded
 *  DB" row — checked by reading the :CommitLog marker directly, since
 *  GraphWriter.commitProposal's own idempotent short-circuit is silent
 *  about which case it hit. */
async function wasAlreadyCommitted(driver: Driver, database: string, proposalId: string): Promise<boolean> {
  const session = driver.session({ database });
  try {
    const result = await session.executeRead((tx) =>
      tx.run("MATCH (c:CommitLog {proposal_id: $proposalId}) RETURN c", { proposalId })
    );
    return result.records.length > 0;
  } finally {
    await session.close();
  }
}

async function applyScenario(driver: Driver, database: string, scenarioName: string): Promise<void> {
  const builder = SCENARIOS[scenarioName];
  if (!builder) {
    throw new Error(`Unknown --scenario "${scenarioName}". Valid scenarios: ${Object.keys(SCENARIOS).join(", ")}.`);
  }
  const plan = builder();
  const alreadyCommitted = await wasAlreadyCommitted(driver, database, plan.proposalId);

  const writer = new GraphWriter(driver);
  const result = await writer.commitProposal(plan);

  if (alreadyCommitted) {
    console.log(`Scenario "${scenarioName}" was already seeded (proposalId="${plan.proposalId}") — no-op, 0 newly created.`);
  } else {
    const totalNodes = Object.values(result.nodeCounts).reduce((sum, n) => sum + (n ?? 0), 0);
    const totalEdges = Object.values(result.edgeCounts).reduce((sum, n) => sum + (n ?? 0), 0);
    console.log(
      `Scenario "${scenarioName}" newly seeded (proposalId="${plan.proposalId}"): ` +
        `${totalNodes} nodes, ${totalEdges} edges, ${result.supersessionsApplied} supersession(s) applied.`
    );
  }
  console.log(JSON.stringify(result, null, 2));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const uri = process.env.SENTINEL_NEO4J_URI ?? "";
  assertSafeToWrite(uri, args.iUnderstandThisIsNotLocal);

  if (!args.reset && !args.scenario) {
    console.log("Nothing to do — pass --scenario=<cuspa-pre|cuspa-post|dev-sample> and/or --reset.");
    return;
  }

  const driver = getDriver();
  await verifyConnectivity(driver);
  const database = getSingletonDatabase();

  try {
    if (args.reset) {
      console.log("Resetting database (MATCH (n) DETACH DELETE n)...");
      await resetDatabase(driver, database);
      console.log("Reset complete.");
    }

    if (args.scenario) {
      await applyScenario(driver, database, args.scenario);
    }
  } finally {
    await closeDriver();
  }
}

// Only auto-run when this file is executed directly (`tsx seed/seed.ts`),
// not when its exports (parseArgs/assertSafeToWrite) are imported by unit
// tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
