// Wires packages/ticketing-adapter into the shared flat ESLint config,
// same pattern as packages/audit-ledger/eslint.config.js.
import sharedConfig from "@sentinel-act/eslint-config";

export default [
  ...sharedConfig,
  {
    ignores: ["**/*.config.ts", "**/*.config.js", "dist/**"]
  }
];
