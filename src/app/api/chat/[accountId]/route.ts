import { NextRequest } from "next/server";
import { streamChat } from "@/agent/chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Memory extraction runs after the last token; give the request room to finish.
export const maxDuration = 300;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params;

  let message: string;
  try {
    const body = await req.json();
    message = String(body?.message ?? "").trim();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  if (!message) return new Response("Empty message", { status: 400 });

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of streamChat(accountId, message)) {
          controller.enqueue(encoder.encode(chunk));
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        // The client renders whatever streamed plus this marker, rather than
        // silently truncating mid-sentence.
        controller.enqueue(encoder.encode(`\n\n[error] ${detail}`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
