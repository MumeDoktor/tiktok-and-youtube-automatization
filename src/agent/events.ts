import { db } from "@/db";
import { eq } from "drizzle-orm";
import { accounts, agentEvents, clips, jobs } from "@/db/schema";
import { telegramText } from "@/lib/telegram";

export type EventLevel = "info" | "warn" | "error" | "success";

/**
 * What the owner hears about on their phone, beyond anything that went wrong.
 *
 * The owner is rarely at the PC, so the phone is where the pipeline has to
 * speak: every warning and failure, and each step that says "this is where
 * your video is" - but not the frame-by-frame chatter in between.
 */
const TOLD = new Set([
  "autopilot.started",
  "autopilot.planned",
  "produce.decided",
  "library.picked",
  "teaser.ready",
  "comments.checked",
  "comments.replied",
  "worker.started",
]);
/** Warnings that change nothing the owner would do. */
const QUIET = new Set(["clip.no_thumbnail", "memory.extract_failed"]);
const ICON: Record<EventLevel, string> = { info: "ℹ️", success: "✅", warn: "⚠️", error: "❌" };

export function logEvent(args: {
  accountId?: string | null;
  level?: EventLevel;
  type: string;
  message: string;
  meta?: unknown;
  /** False when the caller sends its own message (notify, a review video). */
  telegram?: boolean;
}) {
  const { accountId = null, level = "info", type, message, meta } = args;
  db.insert(agentEvents)
    .values({
      accountId,
      level,
      type,
      message,
      meta: meta === undefined ? null : JSON.stringify(meta),
    })
    .run();

  const tag = accountId ? `[${accountId}]` : "[global]";
  const line = `${tag} ${type}: ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);

  const tell = args.telegram ?? ((level === "warn" || level === "error" || TOLD.has(type)) && !QUIET.has(type));
  if (tell) {
    const handle = accountId
      ? db.select().from(accounts).where(eq(accounts.id, accountId)).get()?.handle
      : undefined;
    telegramText(`${ICON[level]} ${handle ? `@${handle} - ` : ""}${message}`);
  }
}

/**
 * Appends a human-readable step to a clip's progress trail.
 *
 * Written for the person waiting, not for the log: "Watching 18 frames of the
 * film" tells them what is happening; "sampleRemoteFrames(n=18)" does not.
 */
export function noteProgress(clipId: string, message: string) {
  const row = db.select().from(clips).where(eq(clips.id, clipId)).get();
  if (!row) return;

  let trail: Array<{ at: number; message: string }> = [];
  try {
    const parsed = JSON.parse(row.progress);
    if (Array.isArray(parsed)) trail = parsed;
  } catch {
    trail = [];
  }

  trail.push({ at: Date.now(), message });
  db.update(clips)
    .set({ progress: JSON.stringify(trail.slice(-30)) })
    .where(eq(clips.id, clipId))
    .run();
}

export type JobType =
  | "sync"
  | "analyze"
  | "make_clip"
  | "find_footage"
  | "produce"
  /** Search for an interview to cut, then cut every beat worth posting from it. */
  | "find_source"
  /** Build a chosen cut into an After Effects edit for the owner to review. */
  | "edit_ae"
  /** Re-edit a rejected video from the owner's review (revise.ts). */
  | "revise_ae"
  /** Turn the speaker's audio into a podcast/storytelling MP4 with Codex. */
  | "edit_codex"
  /** Render a built After Effects edit to the clip's export folder, unattended. */
  | "export_ae"
  /** Make the video for one planned posting slot, then tell the owner when to post it. */
  | "autopilot"
  /** Post a finished video through the Android phone, at its slot. */
  | "publish_phone"
  /** Give Claude the finished MP4, caption and scheduled time, then stop. */
  | "handoff_claude"
  /** "Make one now": library clip or original video, per the account's mix. */
  | "make_video"
  /** Post an approved clip now, through the phone, to its own verified account. */
  | "post_now"
  /** Read the comments on the newest posts and draft replies (comments.ts). */
  | "check_comments"
  /** Send the replies that were approved, through the phone. */
  | "reply_comments"
  /** An 8-12 minute 16:9 documentary for YouTube, chapter by chapter (long.ts). */
  | "make_long";

/** Enqueue a unit of pipeline work for the worker to pick up. */
export function enqueue(args: {
  accountId?: string | null;
  type: JobType;
  payload?: Record<string, unknown>;
  runAt?: Date;
  maxAttempts?: number;
}) {
  const { accountId = null, type, payload = {}, runAt, maxAttempts } = args;
  const row = {
    accountId,
    type,
    payload: JSON.stringify(payload),
    ...(runAt ? { runAt } : {}),
    ...(maxAttempts ? { maxAttempts } : {}),
  };
  const inserted = db.insert(jobs).values(row).returning().get();
  return inserted;
}
