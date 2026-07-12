// Wires packages/graph-db into the shared flat ESLint config, same
// pattern as packages/ui/eslint.config.js.
import sharedConfig from "@sentinel-act/eslint-config";

export default [
  ...sharedConfig,
  {
    ignores: ["**/*.config.ts", "**/*.config.js", "dist/**"]
  }
];
