import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { accounts, clips, jobs } from "@/db/schema";
import { env } from "@/lib/env";
import { mediaDir } from "@/lib/media";
import { formatSlot } from "./autopilot";
import { isApproved } from "./approval";
import { enqueue, logEvent, noteProgress } from "./events";
import { notify } from "./notify";
import { telegramPhoto } from "@/lib/telegram";

/**
 * Posting through the phone.
 *
 * TikTok's API will not post for an unaudited app, so the video goes out the
 * way a person would put it up: through the TikTok app on the Android phone
 * plugged into this PC. This direct driver is only used when the phone
 * backend is selected. Claude receives a finished video in a separate handoff.
 *
 * Only videos made for an autopilot slot are posted, and only at their slot.
 * One that finishes late goes out as soon as it is ready - a late post beats
 * no post.
 */

export type PublishPayload = { clipId: string };

/** The caption as it goes on TikTok: the agent's caption, then its hashtags. */
export function postText(clip: { caption: string | null; hookText: string | null; hashtags: string }): string {
  let tags: string[] = [];
  try {
    tags = JSON.parse(clip.hashtags) as string[];
  } catch {
    tags = [];
  }
  const body = (clip.caption || clip.hookText || "").trim();
  const hashtags = tags
    .map((t) => t.trim().replace(/^#+/, "").replace(/\s+/g, ""))
    .filter(Boolean)
    .filter((t) => !body.toLowerCase().includes(`#${t.toLowerCase()}`))
    .map((t) => `#${t}`)
    .join(" ");
  return [body, hashtags].filter(Boolean).join("\n\n").slice(0, 2200);
}

function pendingPublish(clipId: string) {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.type, "publish_phone"), inArray(jobs.status, ["queued", "running"])))
    .all()
    .find((j) => (JSON.parse(j.payload) as Partial<PublishPayload>).clipId === clipId);
}

function existingHandoff(clipId: string) {
  return db.select().from(jobs).where(eq(jobs.type, "handoff_claude")).all()
    .find((j) => j.status !== "cancelled" &&
      (JSON.parse(j.payload) as Partial<PublishPayload>).clipId === clipId);
}

/**
 * Queues the post for a finished clip, at its slot. A no-op for a clip not
 * made for a slot, with phone publishing off, or with a post already queued.
 */
export function schedulePublish(clipId: string) {
  if (!env.phonePublish) return;
  const clip = db.select().from(clips).where(eq(clips.id, clipId)).get();
  if (!clip || clip.status !== "ready") return;
  // Nothing goes public unreviewed - not even at its autopilot slot.
  if (!isApproved(clipId)) {
    noteProgress(clipId, `Ready - waiting for your OK: npm run approve -- ${clipId}`);
    return;
  }
  const account = db.select().from(accounts).where(eq(accounts.id, clip.accountId)).get();
  if (!account?.autopilot) return;
  if (env.publishBackend === "claude") {
    if (existingHandoff(clipId)) return;
    const old = pendingPublish(clipId);
    if (old?.status === "queued") {
      db.update(jobs).set({ status: "cancelled" }).where(eq(jobs.id, old.id)).run();
    }
    enqueue({ accountId: clip.accountId, type: "handoff_claude", payload: { clipId } });
    noteProgress(clipId, `Video ready; handing MP4 and posting time to Claude${clip.scheduledFor ? ` (${formatSlot(clip.scheduledFor, account.timezone)})` : ""}`);
    return;
  }
  if (!clip.scheduledFor) return;
  if (pendingPublish(clipId)) return;

  const runAt = new Date(Math.max(Date.now(), clip.scheduledFor.getTime()));
  enqueue({
    accountId: clip.accountId,
    type: "publish_phone",
    payload: { clipId } satisfies PublishPayload,
    runAt,
    maxAttempts: env.publishAttempts,
  });
  noteProgress(clipId, `Posting through the phone at ${formatSlot(runAt, account.timezone)}`);
}

export type PhoneResult = { ok: boolean; stage?: string; error?: string; screenshot?: string; dryRun?: boolean };

/** Runs the phone driver and returns the JSON it prints last. */
export function runPhone<T extends PhoneResult = PhoneResult>(args: string[]): Promise<T> {
  return new Promise((resolve) => {
    const child = spawn(env.python, [path.join("src", "lib", "tiktok_phone.py"), ...args], {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
    });
    let out = "";
    const tail: string[] = [];
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => {
      for (const line of c.toString().split(/\r?\n/)) if (line.trim()) tail.push(line);
      if (tail.length > 20) tail.splice(0, tail.length - 20);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15 * 60_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, stage: "start", error: `could not start ${env.python}: ${e.message}` } as T);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const last = out.trim().split(/\r?\n/).pop() ?? "";
      try {
        resolve(JSON.parse(last) as T);
      } catch {
        resolve({ ok: false, stage: "driver", error: `exited ${code}: ${tail.slice(-8).join("\n")}` } as T);
      }
    });
  });
}

/** Posts one clip. Throws on failure so the job retries with backoff. */
export async function publishClip(accountId: string, payload: PublishPayload) {
  const clip = db.select().from(clips).where(eq(clips.id, payload.clipId)).get();
  if (!clip) throw new Error(`No clip ${payload.clipId}`);
  if (clip.status === "posted") return;
  if (!clip.outputPath || !fs.existsSync(clip.outputPath)) {
    throw new Error(`Clip ${clip.id} has no finished video on disk (${clip.outputPath ?? "none"})`);
  }

  const shots = path.join(mediaDir, "phone");
  fs.mkdirSync(shots, { recursive: true });
  const captionFile = path.join(shots, `${clip.id}.caption.txt`);
  fs.writeFileSync(captionFile, postText(clip), "utf8");

  noteProgress(clip.id, `Posting through the phone${env.phoneDryRun ? " (dry run)" : ""}`);
  const args = [
    "post",
    "--file", path.resolve(clip.outputPath),
    "--caption-file", captionFile,
    "--adb", env.adb,
    "--package", env.tiktokPackage,
    "--shots", path.resolve(shots),
    "--tag", clip.id,
  ];
  if (env.phoneSerial) args.push("--serial", env.phoneSerial);
  // Always the CLIP'S account. The phone serves several TikTok accounts and
  // posts to whichever is active; the driver switches to this one and refuses
  // to post unless the Profile tab then reads exactly this handle.
  const account = db.select().from(accounts).where(eq(accounts.id, clip.accountId)).get();
  if (!account) throw new Error(`Clip ${clip.id} has no account`);
  args.push("--account", account.handle);
  if (env.phoneDryRun) args.push("--dry-run");

  const result = await runPhone(args);
  if (!result.ok) {
    const where = result.screenshot ? ` Screenshot: ${result.screenshot}` : "";
    noteProgress(clip.id, `Posting failed at ${result.stage ?? "?"}: ${result.error ?? "unknown"}`);
    // What the phone was showing, straight to the owner: a popup nobody
    // listed is fixed with one tap on the phone, before the retry comes round.
    if (result.screenshot) {
      void telegramPhoto(
        result.screenshot,
        `⚠️ @${account.handle} post stuck at "${result.stage ?? "?"}": ${result.error ?? "unknown"}
` +
          `This is the phone's screen. Clear whatever is in the way on the phone - it retries on its own.`,
      );
    }
    throw new Error(`Phone post failed at ${result.stage ?? "?"}: ${result.error ?? "unknown"}.${where}`);
  }

  if (result.dryRun) {
    noteProgress(clip.id, "Dry run reached the Post button - nothing was posted");
    logEvent({
      accountId,
      type: "publish.dry_run",
      message: `Dry run for "${clip.hookText ?? clip.id}" reached Post without posting.`,
    });
    return;
  }

  db.update(clips).set({ status: "posted" }).where(eq(clips.id, clip.id)).run();
  noteProgress(clip.id, "Posted to TikTok");
  notify({
    accountId,
    level: "success",
    type: "clip.posted",
    title: "Posted to TikTok",
    body: `${clip.hookText || clip.sourceTitle || "Your video"} is up.`,
    meta: { clipId: clip.id },
  });
}

/** Called by the worker when the last attempt at a post has failed. */
export function reportPublishGaveUp(accountId: string | null, message: string, handoff = false) {
  notify({
    accountId,
    level: "error",
    type: handoff ? "clip.handoff_failed" : "clip.post_failed",
    title: handoff ? "Claude handoff failed" : "TikTok post failed",
    body: `Gave up after ${env.publishAttempts} tries. ${message}`.slice(0, 400),
  });
}
