import type { Config } from "tailwindcss";
import sharedConfig from "@sentinel-act/ui/tailwind.config";

// Extends the shared token set in packages/ui so app/ classnames and
// @sentinel-act/ui component classnames resolve against one theme.
const config: Config = {
  ...sharedConfig,
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}"
  ]
};

export default config;
