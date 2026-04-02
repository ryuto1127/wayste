import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // onnxruntime-web needs Node-built-in stubs in the browser bundle.
  // Turbopack (default in Next.js 16) uses `turbopack` config instead of `webpack`.
  turbopack: {
    resolveAlias: {
      fs: { browser: "./lib/empty-module.js" },
      path: { browser: "./lib/empty-module.js" },
      crypto: { browser: "./lib/empty-module.js" },
    },
  },
};

export default nextConfig;
