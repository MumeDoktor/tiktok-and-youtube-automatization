import { db } from "@/db";
import { eq } from "drizzle-orm";
import { agentEvents, clips, jobs } from "@/db/schema";

export type EventLevel = "info" | "warn" | "error" | "success";

export function logEvent(args: {
  accountId?: string | null;
  level?: EventLevel;
  type: string;
  message: string;
  meta?: unknown;
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
  /** Render a built After Effects edit to the clip's export folder, unattended. */
  | "export_ae"
  /** Make the video for one planned posting slot, then tell the owner when to post it. */
  | "autopilot"
  /** Post a finished video through the Android phone, at its slot. */
  | "publish_phone";

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
