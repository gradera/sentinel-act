import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // NOTE: @sentinel-act/graph-db and @sentinel-act/assistant-core also
  // ship raw, uncompiled src/*.ts (same "main"/"exports" convention as
  // @sentinel-act/graph-schema below) and are NOT listed here — a
  // pre-existing gap from before this task (packages/graph-db's audit
  // routes already import it this way without being transpiled), not
  // something introduced or fixed by Spec 12's route handler. `next build`
  // has not actually been exercised against this app yet in this repo;
  // whoever first runs it for real will hit this for both packages at
  // once and should add both here together.
  transpilePackages: ["@sentinel-act/ui", "@sentinel-act/graph-schema"]
};

export default nextConfig;
