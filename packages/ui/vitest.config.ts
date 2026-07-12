import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Vitest config for @sentinel-act/ui (Spec 14 Task 3-12 test suite).
// jsdom environment for RTL/jest-axe; path aliases mirror the package's own
// exports map (`@sentinel-act/ui/lib/*`, `@sentinel-act/ui/components/*`)
// so test files can import components the same way consuming apps do.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@sentinel-act/ui/lib": path.resolve(__dirname, "./src/lib"),
      "@sentinel-act/ui/components": path.resolve(__dirname, "./src/components")
    }
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false
  }
});
