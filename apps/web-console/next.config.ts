import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Spec 15 Task 11 fix: every one of this app's workspace dependencies
  // ships raw, uncompiled src/*.ts ("main"/"exports" pointing at
  // ./src/index.ts, never a dist/ build — see apps/orchestrator/src/server/
  // start.ts's header comment and Spec 15 §13 Open Question 11 for the
  // fuller writeup of this repo-wide gap). Next.js's own transpilePackages
  // is the framework-native fix for exactly this (Webpack/Turbopack
  // transpile these packages' TS on the fly instead of expecting
  // pre-compiled JS) — previously only @sentinel-act/ui and
  // @sentinel-act/graph-schema were listed here, which this task
  // completes to cover every workspace dependency this app actually has
  // (confirmed against package.json's own dependency list).
  transpilePackages: [
    "@sentinel-act/ui",
    "@sentinel-act/graph-schema",
    "@sentinel-act/graph-db",
    "@sentinel-act/report-generation",
    "@sentinel-act/review-contracts",
    "@sentinel-act/assistant-core"
  ]
};

export default nextConfig;
