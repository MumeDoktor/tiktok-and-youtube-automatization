import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clips } from "@/db/schema";
import { mediaDir } from "@/lib/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Serves a finished clip or its thumbnail, so the browser can preview it. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ clipId: string }> },
) {
  const { clipId } = await params;
  const wantThumb = req.nextUrl.searchParams.get("thumb") === "1";

  const clip = db.select().from(clips).where(eq(clips.id, clipId)).get();
  if (!clip) return new NextResponse("Not found", { status: 404 });

  const target = wantThumb ? clip.thumbnailPath : clip.outputPath;
  if (!target) return new NextResponse("Not rendered yet", { status: 404 });

  // Only ever serve from inside the media directory, whatever the row says.
  const resolved = path.resolve(target);
  if (!resolved.startsWith(path.resolve(mediaDir))) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  if (!fs.existsSync(resolved)) return new NextResponse("File is gone", { status: 404 });

  const stat = fs.statSync(resolved);
  const stream = fs.createReadStream(resolved);

  return new NextResponse(stream as unknown as ReadableStream, {
    headers: {
      "Content-Type": wantThumb ? "image/jpeg" : "video/mp4",
      "Content-Length": String(stat.size),
      "Cache-Control": "no-store",
    },
  });
}
