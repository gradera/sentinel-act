// Wires packages/report-generation into the shared flat ESLint config,
// same pattern as packages/graph-db/eslint.config.js / packages/ui/eslint.config.js.
import sharedConfig from "@sentinel-act/eslint-config";

export default [
  ...sharedConfig,
  {
    ignores: ["**/*.config.ts", "**/*.config.js", "dist/**"]
  }
];
