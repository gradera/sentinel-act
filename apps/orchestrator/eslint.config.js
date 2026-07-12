// Wires apps/orchestrator into the shared flat ESLint config, same
// pattern as packages/graph-db/eslint.config.js and
// packages/ui/eslint.config.js. This file didn't exist yet — its absence
// was a pre-existing gap (package.json's "lint" script has always run
// `eslint . --max-warnings 0`, but with no eslint.config.js, ESLint 9
// refuses to run at all rather than falling back to any default).
import sharedConfig from "@sentinel-act/eslint-config";

export default [
  ...sharedConfig,
  {
    ignores: [".mastra/**", "dist/**", "**/*.config.js", "**/*.config.mjs"]
  }
];
