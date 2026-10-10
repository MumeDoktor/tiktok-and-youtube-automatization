import { eq } from "drizzle-orm";
import { db } from "@/db";
import { accounts, clips, settings } from "@/db/schema";
import { approvedKey, isApproved } from "./approval";
import { enqueue, logEvent, noteProgress } from "./events";
import { libraryDir, libraryShare, makeLibraryClip } from "./library";
import { produceNext, reportProduced } from "./produce";

/**
 * "Make one now" for an account: where its next video comes from.
 *
 * An account with a library folder draws most videos from it (library_share,
 * default 0.75) and makes an original narrated story the rest of the time; one
 * without a folder always goes through produceNext, restricted to the formats
 * the account allows (see decideToolFor). Either way the video ends at review
 * in After Effects - nothing here posts.
 */
export async function makeVideo(accountId: string): Promise<string | null> {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) throw new Error(`No account ${accountId}`);

  if (libraryDir(accountId) && Math.random() < libraryShare(accountId)) {
    const id = await makeLibraryClip(accountId);
    if (id) return id;
    // An account that posts only from its folder gets nothing rather than an
    // original video it was never meant to carry.
    if (libraryShare(accountId) >= 1) {
      throw new Error("The library folder has nothing unposted left - this account only posts from there");
    }
    // Otherwise an emptied folder falls through to an original video.
  }
  const { clipId } = await produceNext(accountId);
  reportProduced(accountId, clipId);
  return clipId;
}

export { isApproved };

/**
 * The owner's OK on a clip waiting in After Effects.
 *
 * Marks it approved and asks for the export; when the export lands, the clip
 * posts straight away through the phone (post_now) - to its own account,
 * switched to and verified by the driver. A clip already exported by hand
 * posts immediately.
 */
export function approveClip(clipId: string): string {
  const clip = db.select().from(clips).where(eq(clips.id, clipId)).get();
  if (!clip) throw new Error(`No clip ${clipId}`);
  if (clip.status === "posted") return "already posted";
  if (!["review_in_ae", "ready"].includes(clip.status)) {
    throw new Error(`Clip ${clipId} is "${clip.status}" - only a clip waiting for review can be approved`);
  }
  // A second tap (or a second `npm run approve`) must not queue a second post.
  if (isApproved(clipId)) return "already approved - it is on its way";
  db.insert(settings).values({ key: approvedKey(clipId), value: String(Date.now()) }).run();
  noteProgress(clipId, "Approved by the owner - it posts as soon as it is exported");
  logEvent({ accountId: clip.accountId, type: "clip.approved", message: `Approved: ${clip.hookText ?? clipId}` });
  if (clip.status === "ready") {
    enqueue({ accountId: clip.accountId, type: "post_now", payload: { clipId }, maxAttempts: 3 });
    return "exported already - posting now";
  }
  enqueue({ accountId: clip.accountId, type: "export_ae", payload: { clipId }, maxAttempts: 5 });
  return "exporting, then posting";
}

/** The owner's no on a clip waiting for review: it is set aside and never posts. */
export function rejectClip(clipId: string): string {
  const clip = db.select().from(clips).where(eq(clips.id, clipId)).get();
  if (!clip) throw new Error(`No clip ${clipId}`);
  if (clip.status === "posted") return "already posted - too late to reject";
  if (isApproved(clipId)) return "already approved - it is on its way";
  if (!["review_in_ae", "ready"].includes(clip.status)) return `nothing to reject - it is "${clip.status}"`;
  db.update(clips).set({ status: "declined", error: "Rejected by the owner" }).where(eq(clips.id, clipId)).run();
  noteProgress(clipId, "Rejected by the owner - it will not be posted");
  logEvent({ accountId: clip.accountId, type: "clip.rejected", message: `Rejected: ${clip.hookText ?? clipId}` });
  return "rejected - it will not be posted";
}
