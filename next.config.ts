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

  // Mark onnxruntime-node as an external so Vercel's file tracer pulls in the
  // native binary instead of trying to bundle the .node file.
  serverExternalPackages: ["onnxruntime-node", "sharp"],

  // Ensure the face-detector ONNX model is bundled with serverless functions.
  // Without this, `lib/models/face-detector.onnx` is left outside the function
  // deployment and `fs.readFile` at runtime returns ENOENT.
  outputFileTracingIncludes: {
    "/api/classify": ["./lib/models/face-detector.onnx"],
    "/api/pilot-log": ["./lib/models/face-detector.onnx"],
  },

  // Security headers
  // Note: Content-Security-Policy is set per-request in middleware.ts so we can
  // inject a fresh nonce on every response. A static CSP in this file would
  // have to either allow 'unsafe-inline' (weak) or block Next.js's auto-emitted
  // inline bootstrap scripts (which would break hydration).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "interest-cohort=()" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
