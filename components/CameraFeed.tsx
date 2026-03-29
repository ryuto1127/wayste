"use client";

import {
  useRef,
  useEffect,
  useImperativeHandle,
  forwardRef,
  useState,
} from "react";

export interface CameraFeedHandle {
  captureFrame: (quality?: number) => string | null;
  getVideo: () => HTMLVideoElement | null;
}

interface CameraFeedProps {
  /**
   * Whether to horizontally flip the video feed (mirror effect).
   * Default `false` — suitable for outward-facing kiosk cameras.
   * Set to `true` for front-facing / selfie-style cameras.
   */
  mirror?: boolean;
}

const CameraFeed = forwardRef<CameraFeedHandle, CameraFeedProps>(function CameraFeed({ mirror = false }, ref) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function startCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            facingMode: "environment",
          },
          audio: false,
        });

        if (!mounted) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.onloadedmetadata = () => {
            if (mounted) setReady(true);
          };
        }
      } catch (err) {
        if (!mounted) return;
        if (err instanceof DOMException && err.name === "NotAllowedError") {
          setError("Camera access denied. Please allow camera permissions.");
        } else if (
          err instanceof DOMException &&
          err.name === "NotFoundError"
        ) {
          setError("No camera found. Please connect a camera.");
        } else {
          setError("Failed to start camera.");
        }
      }
    }

    startCamera();

    return () => {
      mounted = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  useImperativeHandle(ref, () => ({
    captureFrame(quality = 0.85): string | null {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || !ready) return null;

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;

      ctx.drawImage(video, 0, 0);
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      const base64 = dataUrl.split(",")[1];
      return base64 ?? null;
    },
    getVideo(): HTMLVideoElement | null {
      return ready ? videoRef.current : null;
    },
  }));

  if (error) {
    return (
      <div className="flex items-center justify-center h-full bg-neutral-900 rounded-2xl">
        <div className="text-center p-8">
          <div className="text-5xl mb-4">📷</div>
          <p className="text-xl text-red-400 font-medium">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full overflow-hidden rounded-2xl bg-neutral-900">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="h-full w-full object-cover"
        style={mirror ? { transform: "scaleX(-1)" } : undefined}
      />
      <canvas ref={canvasRef} className="hidden" />
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center bg-neutral-900">
          <div className="text-xl text-neutral-400 animate-pulse">
            Starting camera...
          </div>
        </div>
      )}
    </div>
  );
});

export default CameraFeed;
