import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { accounts } from "@/db/schema";
import { cancelAutopilot, planAutopilot } from "@/agent/autopilot";
import { logEvent } from "@/agent/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ enabled: z.boolean() });

/**
 * Switches autopilot for one account. Switching on plans the next slot right
 * away, so the page shows it without waiting for the worker's next tick.
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
    return NextResponse.json({ error: "enabled must be true or false" }, { status: 400 });
  }
  const { enabled } = parsed.data;

  const updated = db
    .update(accounts)
    .set({ autopilot: enabled })
    .where(eq(accounts.id, id))
    .returning()
    .get();

  if (!enabled) {
    const dropped = cancelAutopilot(id);
    logEvent({
      accountId: id,
      type: "autopilot.off",
      message: dropped > 0 ? "Autopilot switched off - the planned slot was dropped" : "Autopilot switched off",
    });
    return NextResponse.json({ ok: true, enabled });
  }

  logEvent({ accountId: id, type: "autopilot.on", message: "Autopilot switched on" });
  const job = planAutopilot(updated);
  return NextResponse.json({ ok: true, enabled, planned: Boolean(job) });
}
