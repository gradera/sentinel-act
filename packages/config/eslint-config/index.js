// Shared flat ESLint config for the Sentinel Act monorepo.
// Apps and packages extend this and layer framework-specific rules on top.
const tseslint = require("typescript-eslint");

module.exports = tseslint.config(
  {
    ignores: ["dist/**", ".next/**", "node_modules/**"]
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }]
    }
  }
);
