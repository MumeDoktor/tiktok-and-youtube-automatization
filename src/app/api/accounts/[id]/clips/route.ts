import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { accounts, clips } from "@/db/schema";
import { enqueue, logEvent } from "@/agent/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  url: z.string().max(2000).optional(),
  /** A footage angle, e.g. "F-22 Raptor night launch". Uses the DoD archive. */
  angle: z.string().max(300).optional(),
});

/** POST a source URL. The worker does the rest. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const account = db.select().from(accounts).where(eq(accounts.id, id)).get();
  if (!account) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  const url = parsed.success ? parsed.data.url?.trim() : undefined;
  const angle = parsed.success ? parsed.data.angle?.trim() : undefined;

  if (!url && !angle) {
    return NextResponse.json(
      { error: "Give either a video URL or a footage angle to search the archive for." },
      { status: 400 },
    );
  }
  if (url && !/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: "That does not look like a URL" }, { status: 400 });
  }

  // A DVIDS clip stores the requested angle in sourceUrl until an asset is picked.
  const clip = db
    .insert(clips)
    .values({
      accountId: id,
      sourceType: url ? "url" : "dvids",
      sourceUrl: (url ?? angle)!,
    })
    .returning()
    .get();

  enqueue({
    accountId: id,
    type: url ? "make_clip" : "find_footage",
    payload: { clipId: clip.id },
  });

  logEvent({
    accountId: id,
    type: "clip.queued",
    message: url ? `Queued a clip from ${url}` : `Searching the archive for "${angle}"`,
  });

  return NextResponse.json({ ok: true, clipId: clip.id });
}
