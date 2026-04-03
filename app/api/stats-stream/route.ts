import { analyzeFeedback } from "@/lib/feedback-analysis";

// Dashboard SSE stream — no auth required (read-only aggregate stats).
// Admin auth is only enforced on write endpoints (/api/overrides POST).

export async function GET(request: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // Send current stats immediately on connect
      try {
        const stats = await analyzeFeedback();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(stats)}\n\n`));
      } catch (err) {
        controller.enqueue(
          encoder.encode(`event: error\ndata: ${JSON.stringify({ error: "Failed to load stats" })}\n\n`)
        );
      }

      // Poll every 3 seconds
      const id = setInterval(async () => {
        try {
          const stats = await analyzeFeedback();
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(stats)}\n\n`));
        } catch (err) {
          controller.enqueue(
            encoder.encode(`event: error\ndata: ${JSON.stringify({ error: "Redis error" })}\n\n`)
          );
        }
      }, 3000);

      // Clean up on abort
      request.signal.addEventListener("abort", () => {
        clearInterval(id);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
