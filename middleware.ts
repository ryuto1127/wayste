/**
 * Next.js middleware — protects admin pages, gates the kiosk page behind a
 * device-unlock flow, and sets a per-request nonce-based Content-Security-Policy.
 *
 * # CSP
 * A fresh base64 nonce is generated on every request and added to `script-src`
 * alongside `'strict-dynamic'`. The nonce is also forwarded to Next.js via the
 * `x-nonce` request header so that Next.js stamps it onto the inline bootstrap
 * scripts it emits for hydration. Any downstream chunks loaded by those
 * bootstrap scripts are trusted transitively via `'strict-dynamic'`.
 *
 * # Kiosk session redirect
 * - Visiting `/kiosk` without a valid `kiosk_session` cookie redirects to
 *   `/kiosk/unlock` so staff can authorize the device.
 * - Visiting `/kiosk/unlock` with a valid `kiosk_session` cookie redirects
 *   back to `/kiosk` so already-authorized devices skip the unlock screen.
 * - The marketing landing page lives at `/` and is publicly accessible.
 *
 * # Admin auth
 * Admin pages and their backing API routes require either a valid
 * `admin_session` cookie, an `x-api-key` header, or HTTP Basic Auth.
 *
 * Kiosk-facing API endpoints (`/api/classify`, `/api/pilot-log POST`,
 * `/api/kiosk/session`) are authenticated at the route level via
 * `lib/kiosk-auth.ts`, not here.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { hmacHex, timingSafeEqualStr } from "@/lib/crypto-utils";
import { recordAudit, callerSource } from "@/lib/audit-log";
import { KIOSK_SESSION_COOKIE, makeKioskSessionToken } from "@/lib/kiosk-auth";

const ADMIN_SESSION_COOKIE = "admin_session";
const ADMIN_SESSION_MAX_AGE = 60 * 60 * 4; // 4 hours
const ADMIN_SESSION_INFO = "wayste-admin-session-v1";

/** Paths that require admin Basic Auth. */
const ADMIN_PATHS = [
  "/review",
  "/insights",
  "/api/review",
  "/api/pilot-log",
  "/api/pilot-image",
  "/api/health",
  "/api/calibration",
  "/api/dashboard-metrics",
];

function isAdminPath(pathname: string): boolean {
  return ADMIN_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}

/**
 * Dev-only auth bypass check. Exact hostname match (port stripped) so a
 * spoofed `Host: localhost.evil.com` can never pass, and never active in
 * production builds regardless of the Host header.
 */
function isLocalhost(host: string): boolean {
  if (process.env.NODE_ENV === "production") return false;
  const hostname = host.split(":")[0];
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

async function makeAdminSessionToken(adminKey: string): Promise<string> {
  return hmacHex(adminKey, ADMIN_SESSION_INFO);
}

/** 128-bit base64 nonce — unpredictable per request. */
function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    // Scripts: nonce + strict-dynamic lets Next.js's bootstrap inline script
    // run and transitively trust the chunks it loads. wasm-unsafe-eval is
    // required by onnxruntime-web.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'`,
    // Tailwind injects inline <style> tags
    "style-src 'self' 'unsafe-inline'",
    // Pilot images load through the /api/pilot-image proxy ('self'); no
    // client code talks to OpenAI/Upstash directly (server-only), so those
    // hosts are deliberately NOT allowed — wildcard SaaS namespaces are
    // attacker-provisionable exfiltration channels.
    "img-src 'self' blob: data:",
    // jsdelivr + googleapis: MediaPipe WASM/model. huggingface + hf.co:
    // in-browser VLM weights (Tier 1.5 "browser" mode; LFS downloads
    // redirect to *.hf.co CDN hosts).
    "connect-src 'self' https://cdn.jsdelivr.net https://storage.googleapis.com https://huggingface.co https://*.huggingface.co https://*.hf.co",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

/** Validate the kiosk_session cookie without involving route-level auth. */
async function hasValidKioskSession(request: NextRequest): Promise<boolean> {
  const kioskToken = process.env.KIOSK_API_TOKEN;
  const host = request.headers.get("host") ?? "";

  if (!kioskToken) {
    // Matches verifyKioskRequest dev-bypass: localhost without a token is OK.
    return isLocalhost(host);
  }

  const presented = request.cookies.get(KIOSK_SESSION_COOKIE)?.value;
  if (!presented) return false;
  const expected = await makeKioskSessionToken(kioskToken);
  return timingSafeEqualStr(presented, expected);
}

/**
 * Build a NextResponse that carries the CSP header on the response AND
 * forwards the nonce to downstream Next.js rendering via the `x-nonce`
 * request header. Callers can pass a `mutate` hook to set extra cookies.
 */
function passThrough(
  request: NextRequest,
  nonce: string,
  csp: string,
  mutate?: (res: NextResponse) => void,
): NextResponse {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy", csp);
  if (mutate) mutate(res);
  return res;
}

function redirectWithCsp(
  request: NextRequest,
  to: string,
  csp: string,
): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = to;
  url.search = "";
  const res = NextResponse.redirect(url);
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const nonce = generateNonce();
  const csp = buildCsp(nonce);

  // ── Kiosk session gate (HTML routes only) ──
  if (pathname === "/kiosk" || pathname === "/kiosk/unlock") {
    const kioskAuthed = await hasValidKioskSession(request);
    if (pathname === "/kiosk" && !kioskAuthed) {
      return redirectWithCsp(request, "/kiosk/unlock", csp);
    }
    if (pathname === "/kiosk/unlock" && kioskAuthed) {
      return redirectWithCsp(request, "/kiosk", csp);
    }
    return passThrough(request, nonce, csp);
  }

  // ── Admin auth for protected paths ──
  if (isAdminPath(pathname)) {
    // /api/pilot-log POST is a kiosk endpoint — let route-level kiosk auth handle it
    if (pathname === "/api/pilot-log" && request.method === "POST") {
      return passThrough(request, nonce, csp);
    }

    const adminKey = process.env.ADMIN_API_KEY;

    if (!adminKey) {
      const host = request.headers.get("host") ?? "";
      if (isLocalhost(host)) return passThrough(request, nonce, csp);
      return new NextResponse(
        "Server misconfiguration: ADMIN_API_KEY is not set.",
        { status: 500 },
      );
    }

    const expectedToken = await makeAdminSessionToken(adminKey);

    // 1. Existing session cookie
    const sessionCookie = request.cookies.get(ADMIN_SESSION_COOKIE)?.value;
    if (sessionCookie && (await timingSafeEqualStr(sessionCookie, expectedToken))) {
      return passThrough(request, nonce, csp);
    }

    // 2. x-api-key header
    const apiKey = request.headers.get("x-api-key");
    if (apiKey && (await timingSafeEqualStr(apiKey, adminKey))) {
      recordAudit({
        type: "admin.login",
        source: callerSource(request),
        path: pathname,
        extra: { method: "x-api-key" },
      });
      return passThrough(request, nonce, csp, (res) => {
        res.cookies.set(ADMIN_SESSION_COOKIE, expectedToken, {
          httpOnly: true,
          secure: request.nextUrl.protocol === "https:",
          sameSite: "lax",
          maxAge: ADMIN_SESSION_MAX_AGE,
          path: "/",
        });
      });
    }

    // 3. HTTP Basic Auth
    const authHeader = request.headers.get("authorization");
    if (authHeader?.startsWith("Basic ")) {
      try {
        const decoded = atob(authHeader.slice(6));
        const password = decoded.includes(":")
          ? decoded.split(":").slice(1).join(":")
          : decoded;
        if (await timingSafeEqualStr(password, adminKey)) {
          recordAudit({
            type: "admin.login",
            source: callerSource(request),
            path: pathname,
            extra: { method: "basic" },
          });
          return passThrough(request, nonce, csp, (res) => {
            res.cookies.set(ADMIN_SESSION_COOKIE, expectedToken, {
              httpOnly: true,
              secure: request.nextUrl.protocol === "https:",
              sameSite: "lax",
              maxAge: ADMIN_SESSION_MAX_AGE,
              path: "/",
            });
          });
        }
      } catch {
        // fall through to 401
      }
    }

    // Deny
    if (apiKey || authHeader?.startsWith("Basic ")) {
      recordAudit({
        type: "admin.login_fail",
        source: callerSource(request),
        path: pathname,
      });
    }
    return new NextResponse("Authentication required", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Basic realm="wayste Admin"',
        "Content-Security-Policy": csp,
      },
    });
  }

  // ── Everything else (public pages, non-admin API) ──
  return passThrough(request, nonce, csp);
}

export const config = {
  // Run on HTML pages (for CSP + kiosk redirect) and on protected API routes
  // (for admin auth). Static assets and image/font optimization paths are
  // excluded.
  matcher: [
    "/kiosk",
    "/kiosk/unlock",
    "/review/:path*",
    "/insights/:path*",
    "/api/review/:path*",
    "/api/pilot-log",
    "/api/pilot-image/:path*",
    "/api/health",
    "/api/calibration",
    "/api/dashboard-metrics",
  ],
};
