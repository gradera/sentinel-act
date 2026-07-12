// Wires apps/web-console into the shared flat ESLint config, same pattern
// as packages/graph-db/eslint.config.js and packages/ui/eslint.config.js.
// This file didn't exist yet — its absence was a pre-existing gap
// (package.json's "lint" script has always run `eslint . --max-warnings
// 0`, but with no eslint.config.js, ESLint 9 refuses to run at all).
//
// No Next.js-specific plugin (eslint-config-next / @next/eslint-plugin-next)
// is wired in here because neither is a dependency of this package yet —
// adding one is a real decision (rule set, React version alignment) for
// whoever owns the Web Governance Console specs (09/10), not something to
// silently bundle in while just unblocking `pnpm lint` repo-wide.
import sharedConfig from "@sentinel-act/eslint-config";

export default [
  ...sharedConfig,
  {
    ignores: [".next/**", "next-env.d.ts", "**/*.config.ts", "**/*.config.mjs", "**/*.config.js"]
  }
];
