import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const encoder = new TextEncoder();
  const searchParams = req.nextUrl.searchParams;
  const totalFindings = parseInt(searchParams.get("total") || "100", 10);

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for (let i = 1; i <= totalFindings; i++) {
          // Simulate batch remediation progress chunk
          const progress = Math.round((i / totalFindings) * 100);
          const data = JSON.stringify({
            processed: i,
            total: totalFindings,
            progress,
            status: i === totalFindings ? "completed" : "processing",
            message: `Remediating finding ${i} of ${totalFindings}...`,
          });

          controller.enqueue(encoder.encode(`data: ${data}\n\n`));

          // Small artificial delay for smooth real-time streaming effect
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      } catch (error) {
        const errData = JSON.stringify({ status: "error", message: "Stream interrupted" });
        controller.enqueue(encoder.encode(`data: ${errData}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
