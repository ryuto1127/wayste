"use client";

export default function IdleScreen() {
  return (
    <div className="flex flex-col items-center justify-center h-full w-full select-none">
      {/* Animated recycling icon */}
      <div className="mb-8 animate-[spin_8s_linear_infinite]">
        <svg
          width="120"
          height="120"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-emerald-400"
        >
          <path d="M7 19H4.815a1.83 1.83 0 0 1-1.57-.881 1.785 1.785 0 0 1-.004-1.784L7.196 9.5" />
          <path d="M11 19h8.203a1.83 1.83 0 0 0 1.556-.89 1.784 1.784 0 0 0 0-1.775l-1.226-2.12" />
          <path d="m14 16-3 3 3 3" />
          <path d="M8.293 13.596 4.875 7.97l.001-.001a1.784 1.784 0 0 1 1.568-.896H13" />
          <path d="m10 10 3-3-3-3" />
          <path d="M15.707 10.404 19.125 16.03a1.784 1.784 0 0 1-1.568.896H11" />
          <path d="m17 7 3 3-3 3" />
        </svg>
      </div>

      <h1 className="text-5xl md:text-7xl font-bold text-white mb-6 tracking-tight text-center">
        Recycling Buddy
      </h1>

      <div className="max-w-lg text-center space-y-4">
        <p className="text-2xl md:text-3xl text-neutral-300 font-light">
          Hold your item in front of the camera
        </p>
        <p className="text-lg text-neutral-500">
          The system will tell you which bin to use
        </p>
      </div>

      {/* Pulsing indicator */}
      <div className="mt-12 flex items-center gap-3">
        <span className="relative flex h-4 w-4">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-4 w-4 bg-emerald-500" />
        </span>
        <span className="text-lg text-neutral-400">Camera ready</span>
      </div>
    </div>
  );
}
