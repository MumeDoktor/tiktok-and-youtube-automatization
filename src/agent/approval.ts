import { eq } from "drizzle-orm";
import { db } from "@/db";
import { settings } from "@/db/schema";

/**
 * The owner's OK on a clip, kept in the settings table as `approved:<clipId>`.
 *
 * Every path to a public post checks it: the owner reviews each video before
 * it goes out (decided 2026-09-30), whether it came from autopilot, a library
 * pick or "make one now".
 */
export const approvedKey = (clipId: string) => `approved:${clipId}`;

export function isApproved(clipId: string): boolean {
  return !!db.select().from(settings).where(eq(settings.key, approvedKey(clipId))).get();
}
