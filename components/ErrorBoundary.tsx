"use client";

import { Component, type ReactNode } from "react";
import { t, type Locale } from "@/lib/i18n";

interface Props {
  children: ReactNode;
  /** Locale for the error screen text. Defaults to "en". */
  locale?: Locale;
}

interface State {
  hasError: boolean;
  countdown: number;
}

/** Auto-reload interval in seconds. */
const RELOAD_DELAY_S = 10;

/**
 * Catches unhandled render errors and displays a recovery screen.
 * Automatically reloads the page after RELOAD_DELAY_S seconds so
 * an unattended kiosk never stays on a blank/broken screen.
 */
export default class ErrorBoundary extends Component<Props, State> {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, countdown: RELOAD_DELAY_S };
  }

  static getDerivedStateFromError(): Partial<State> {
    return { hasError: true, countdown: RELOAD_DELAY_S };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary] Unhandled error:", error, info.componentStack);
  }

  componentDidUpdate(_: Props, prevState: State) {
    if (this.state.hasError && !prevState.hasError) {
      this.startCountdown();
    }
  }

  componentWillUnmount() {
    this.clearTimer();
  }

  private startCountdown() {
    this.clearTimer();
    this.timer = setInterval(() => {
      this.setState((prev) => {
        if (prev.countdown <= 1) {
          this.clearTimer();
          window.location.reload();
          return prev;
        }
        return { ...prev, countdown: prev.countdown - 1 };
      });
    }, 1000);
  }

  private clearTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  render() {
    if (this.state.hasError) {
      const locale: Locale = this.props.locale ?? "en";
      const countdownMsg = t(locale, "restartingIn").replace(
        "{seconds}",
        String(this.state.countdown),
      );
      return (
        <div className="h-screen w-screen bg-neutral-950 flex flex-col items-center justify-center p-8 text-center">
          <div className="text-6xl mb-6">⚠️</div>
          <h1 className="text-2xl font-bold text-white mb-3">
            {t(locale, "systemErrorTitle")}
          </h1>
          <p className="text-neutral-400 text-lg mb-2">
            {t(locale, "systemErrorDesc")}
          </p>
          <p className="text-neutral-500 text-sm">{countdownMsg}</p>
        </div>
      );
    }

    return this.props.children;
  }
}
