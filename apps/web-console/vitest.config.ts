import path from "node:path";
import { defineConfig } from "vitest/config";

// Vitest config for @sentinel-act/web-console's lib/console/**/*.test.ts and
// app/api/console/**/*.test.ts suites (Spec 09 Task 11 — unit + BFF
// route-handler integration tests). Node environment, not jsdom: nothing in
// either suite renders React — Next.js App Router route handlers are plain
// exported async functions per Next's own contract, and this suite calls
// them directly with constructed `NextRequest` objects rather than spinning
// up `next dev`/`next start`, so no simulated `window`/`document` is needed.
// Mirrors apps/orchestrator/vitest.config.ts's `environment: "node"` /
// `globals: false` choices for the same reason that file gives.
//
// `css.postcss` is pinned to an inline empty-plugin config rather than left
// to Vite's default behavior of searching the project root for a PostCSS
// config file: apps/web-console/postcss.config.mjs references `tailwindcss`
// via `require`, and Vite's config-resolution step probes for it eagerly at
// startup even though nothing this suite imports triggers a CSS transform —
// pinning avoids that irrelevant lookup (and the "Cannot find module
// 'tailwindcss'" startup failure it produces when `tailwindcss` isn't
// resolvable from whichever node_modules the vitest binary itself was
// invoked from — see this app's test-running notes for why that can differ
// from apps/web-console's own node_modules in this monorepo's sandbox).
//
// `resolve.alias` reproduces this app's own tsconfig.json `"@/*": ["./*"]`
// path mapping by hand: Vite/vitest does not read tsconfig `paths` on its
// own without the `vite-tsconfig-paths` plugin, which is not a dependency of
// this app and this stage may not add new dependencies.
export default defineConfig({
  css: { postcss: { plugins: [] } },
  resolve: {
    alias: [{ find: /^@\//, replacement: `${path.resolve(__dirname)}/` }]
  },
  test: {
    environment: "node",
    globals: false,
    testTimeout: 30_000
  }
});
