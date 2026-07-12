// Wires packages/ui into the shared flat ESLint config. This file did
// not exist anywhere in the repo yet (no app/package had one) — added
// here because Spec 14's Definition of Done requires
// `pnpm --filter @sentinel-act/ui lint` to actually run, not just be a
// script string that errors on a missing config.
import sharedConfig from "@sentinel-act/eslint-config";

export default [
  ...sharedConfig,
  {
    ignores: ["**/*.config.ts", "**/*.config.js"]
  }
];
