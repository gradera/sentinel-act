import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@sentinel-act/ui", "@sentinel-act/graph-schema"]
};

export default nextConfig;
