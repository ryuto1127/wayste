"use client";

/**
 * Kiosk Unlock Page
 *
 * One-time setup page for a new kiosk device. Staff enters the kiosk token,
 * which is sent as `Authorization: Bearer <token>` to /api/kiosk/session.
 * On success the device receives a 30-day HttpOnly `kiosk_session` cookie;
 * subsequent calls to /api/classify and /api/pilot-log work without the
 * token ever being kept in the browser (no localStorage, no variables).
 *
 * The token is NEVER put in a URL — query strings leak into server logs,
 * browser history, and referer headers. Staff pastes it into the form.
 */

import { useRef, useState } from "react";

export default function KioskUnlockPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const token = inputRef.current?.value.trim() ?? "";
    if (!token) {
      setStatus("error");
      setErrorMsg("Please enter a token. / トークンを入力してください。");
      return;
    }
    setStatus("loading");
    setErrorMsg(null);
    try {
      const res = await fetch("/api/kiosk/session", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setStatus("success");
        if (inputRef.current) inputRef.current.value = "";
      } else if (res.status === 401) {
        setStatus("error");
        setErrorMsg("Invalid token. Please check and try again. / トークンが正しくありません。");
      } else {
        setStatus("error");
        setErrorMsg(`Server error (${res.status}). / サーバーエラーが発生しました。`);
      }
    } catch {
      setStatus("error");
      setErrorMsg("Network error. / ネットワークエラーが発生しました。");
    }
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-white flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <h1 className="text-2xl font-semibold mb-2">Unlock This Kiosk</h1>
        <p className="text-sm text-neutral-400 mb-6">
          このデバイスを使えるようにします。管理者から受け取ったトークンを1度だけ入力してください。
          <br />
          Enter the kiosk token once to authorize this device.
        </p>

        {status === "success" ? (
          <div className="rounded-lg border border-emerald-700 bg-emerald-900/30 p-4 mb-4">
            <p className="font-medium mb-2">Unlocked. / アンロックしました。</p>
            <p className="text-sm text-neutral-300 mb-4">
              This device is now authorized for 30 days. <br />
              このデバイスは 30 日間使用できます。
            </p>
            <a
              href="/"
              className="inline-block rounded-md bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 text-sm font-medium"
            >
              Open Kiosk / キオスクを開く
            </a>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <label className="block">
              <span className="text-sm text-neutral-300">Kiosk Token / トークン</span>
              <input
                ref={inputRef}
                type="password"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="mt-1 w-full rounded-md bg-neutral-900 border border-neutral-700 px-3 py-2 text-white font-mono text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                placeholder="paste token here"
                disabled={status === "loading"}
              />
            </label>

            {errorMsg && (
              <p className="text-sm text-red-400" role="alert">
                {errorMsg}
              </p>
            )}

            <button
              type="submit"
              disabled={status === "loading"}
              className="w-full rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:bg-neutral-700 disabled:text-neutral-400 text-white py-2 font-medium"
            >
              {status === "loading" ? "Unlocking..." : "Unlock / アンロック"}
            </button>
          </form>
        )}

        <p className="mt-8 text-xs text-neutral-500">
          Tip: after unlocking, you can close this tab. The authorization is stored as a secure cookie on this device only.
        </p>
      </div>
    </div>
  );
}
