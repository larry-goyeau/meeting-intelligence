import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Pinned so the bundler does not walk up and adopt a parent directory as the
  // workspace root when one happens to contain a lockfile.
  turbopack: { root: import.meta.dirname },
  outputFileTracingIncludes: {
    "/api/**/*": ["./data/**/*"],
  },
  logging: {
    fetches: { fullUrl: false },
  },
};

export default nextConfig;
