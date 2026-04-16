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
  },

  // Security headers
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Prevent MIME-type sniffing
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Block embedding in iframes (clickjacking protection)
          { key: "X-Frame-Options", value: "DENY" },
          // Only send origin as referrer to external sites
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Opt out of Google's FLoC / Topics API
          { key: "Permissions-Policy", value: "interest-cohort=()" },
          // CSP: allow self + ONNX WASM eval + MediaPipe CDN + Vercel Blob
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              // Scripts: self + wasm-unsafe-eval for ONNX Runtime Web
              "script-src 'self' 'wasm-unsafe-eval'",
              // Styles: self + inline (Tailwind)
              "style-src 'self' 'unsafe-inline'",
              // Images: self + blob (canvas) + Vercel Blob storage
              "img-src 'self' blob: data: https://*.public.blob.vercel-storage.com",
              // Connect: self + MediaPipe CDN + Google Storage (models) + OpenAI + Upstash
              "connect-src 'self' https://cdn.jsdelivr.net https://storage.googleapis.com https://api.openai.com https://*.upstash.io",
              // Media: self + blob (camera)
              "media-src 'self' blob:",
              // Workers: self + blob (ONNX web workers)
              "worker-src 'self' blob:",
              // No iframes
              "frame-ancestors 'none'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
