"use client";

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
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

  private handleRetryNow = () => {
    this.clearTimer();
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen w-screen bg-neutral-950 flex flex-col items-center justify-center p-8 text-center">
          <div className="text-6xl mb-6">⚠️</div>
          <h1 className="text-2xl font-bold text-white mb-3">
            System Temporarily Unavailable
          </h1>
          <p className="text-neutral-400 text-lg mb-2">
            The kiosk encountered an error and will restart automatically.
          </p>
          <p className="text-neutral-500 text-sm mb-8">
            Restarting in {this.state.countdown} seconds…
          </p>
          <button
            onClick={this.handleRetryNow}
            className="px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-medium text-lg transition-colors"
          >
            Restart Now
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
