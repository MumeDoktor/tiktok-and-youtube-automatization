import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { accounts, jobs } from "@/db/schema";
import { enqueue, logEvent } from "@/agent/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ type: z.enum(["sync", "analyze", "produce"]) });

/**
 * Queues one job by hand. The worker picks it up on its next poll - this route
 * never runs the work inline, so a slow sync cannot block the request.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const account = db.select().from(accounts).where(eq(accounts.id, id)).get();
  if (!account) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "type must be sync, analyze or produce" }, { status: 400 });
  }
  const { type } = parsed.data;

  // Do not stack duplicates - a second sync while one is pending is wasted credit.
  const pending = db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.accountId, id),
        eq(jobs.type, type),
        inArray(jobs.status, ["queued", "running"]),
      ),
    )
    .get();

  if (pending) {
    return NextResponse.json({
      ok: true,
      queued: false,
      message: `A ${type} job is already ${pending.status}.`,
    });
  }

  const job = enqueue({ accountId: id, type });
  logEvent({ accountId: id, type: "job.queued", message: `Queued ${type} by hand` });

  return NextResponse.json({ ok: true, queued: true, jobId: job.id });
}
