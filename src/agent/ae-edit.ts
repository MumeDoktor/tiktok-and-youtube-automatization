import fs from "node:fs";
import path from "node:path";

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clips } from "@/db/schema";
import {
  aeBridgeAlive,
  aeExportDir,
  newestAeExport,
  readAeOutcome,
  runAeEditor,
  runAeExport,
} from "@/lib/ae-editor";
import { env } from "@/lib/env";
import { extractThumbnail, probe } from "@/lib/media";
import { postBy } from "./autopilot";
import { enqueue, noteProgress } from "./events";
import { notify } from "./notify";
import { isApproved } from "./approval";
import { sendForReview } from "./telegram-review";

/**
 * Clips edited in After Effects.
 *
 * The cut is still chosen here - what to make, which source, which segment, the
 * narration - and the video goes to ai_aget_ae to be edited. It comes back as a
 * project to review, not a file: the owner watches it in After Effects, fixes
 * what they want, and exports. This file is the three moments around that:
 * handing the video over, waiting for After Effects, and picking up the export.
 */

export type AeEditPayload = {
  clipId: string;
  /** The video the editor cuts from: a downloaded segment, or a narrated pre-cut. */
  sourcePath: string;
  targetSec: number;
  /** A bed laid under the finished edit, rather than baked into the source. */
  musicPath?: string | null;
  /** Edit every span as given - the source is already the story. */
  keepAll?: boolean;
  /** The source is already captioned (a library clip): add motion only. */
  motionOnly?: boolean;
  appetite?: number;
  /** From the owner's review (see revise.ts). */
  musicDb?: number;
  dropSpans?: number[];
};

function setStatus(clipId: string, status: string, fields: Record<string, unknown> = {}) {
  db.update(clips)
    .set({ status: status as never, ...fields })
    .where(eq(clips.id, clipId))
    .run();
}

/**
 * Hands a clip to the After Effects editor.
 *
 * Safe to run again: the editor skips every stage already on disk, and refuses
 * to build an edit it already built. A clip that cannot be built yet because
 * After Effects is closed, or busy with a project someone has open, is put back
 * on the queue and the owner is told once - not once per retry.
 */
export async function editInAe(accountId: string, payload: AeEditPayload) {
  const clip = db.select().from(clips).where(eq(clips.id, payload.clipId)).get();
  if (!clip) throw new Error(`No clip ${payload.clipId}`);
  if (["review_in_ae", "ready", "posted"].includes(clip.status)) return;

  const hook = clip.hookText || clip.sourceTitle || "A clip";
  const before = readAeOutcome(clip.id);
  const retry = () =>
    enqueue({
      accountId,
      type: "edit_ae",
      payload,
      runAt: new Date(Date.now() + env.aeRetryMinutes * 60_000),
    });

  // Waiting on a closed After Effects costs nothing to confirm: the analysis is
  // already on disk and the heartbeat file says the bridge is down. Starting
  // the editor only to hear that again would recompile it every few minutes.
  if (
    clip.status === "waiting_for_ae" &&
    before?.status === "waiting_for_ae" &&
    before.reason === "bridge_not_running" &&
    !aeBridgeAlive()
  ) {
    retry();
    return;
  }

  setStatus(clip.id, "editing", { error: null });
  noteProgress(clip.id, "Handing the cut to the After Effects editor");

  const outcome = await runAeEditor({
    clipId: clip.id,
    sourcePath: payload.sourcePath,
    targetSec: payload.targetSec,
    musicPath: payload.musicPath,
    keepAll: payload.keepAll,
    motionOnly: payload.motionOnly,
    appetite: payload.appetite,
    musicDb: payload.musicDb,
    dropSpans: payload.dropSpans,
    script: spokenText(clip.script),
    onProgress: (message) => noteProgress(clip.id, message),
  });

  if (outcome.status === "waiting_for_ae") {
    setStatus(clip.id, "waiting_for_ae");
    const toldAlready =
      clip.status === "waiting_for_ae" &&
      before?.status === "waiting_for_ae" &&
      before.reason === outcome.reason;
    if (!toldAlready) {
      notify({
        accountId,
        level: "warn",
        type: "clip.waiting_for_ae",
        title: "After Effects needed",
        body: `${hook}: ${outcome.message}`,
        meta: { clipId: clip.id, reason: outcome.reason },
      });
    }
    retry();
    return;
  }

  if (outcome.status === "failed") {
    const message = `The After Effects editor failed at "${outcome.stage}": ${outcome.error}`;
    setStatus(clip.id, "failed", { error: message.slice(0, 2000) });
    notify({
      accountId,
      level: "error",
      type: "clip.ae_failed",
      title: "Edit failed",
      body: `${hook}: failed at ${outcome.stage}`,
      meta: { clipId: clip.id, stage: outcome.stage },
    });
    // Thrown so the job retries - the editor resumes from the stage that failed.
    throw new Error(message);
  }

  // A rebuild makes every EARLIER export stale. Left in the export folder, the
  // old file was taken for the new render - "ready" pointed at the previous cut
  // and the rebuilt edit was never rendered. Only files older than this build
  // move (aside, not deleted): moving everything up front also moved the one
  // real render of an edit the editor then reported as "already built".
  supersedeExports(clip.id, Date.parse(outcome.builtAt));

  setStatus(clip.id, "review_in_ae", {
    outputDurationSec: outcome.durationSec,
    error: null,
  });
  noteProgress(
    clip.id,
    `Built ${outcome.comp}: ${Math.round(outcome.durationSec)}s, ${outcome.segments} cuts, ` +
      `${outcome.treatments} treatments, ${outcome.captions} captions`,
  );

  if (env.aeAutoExport) {
    noteProgress(clip.id, "Exporting the edit - no review, it goes straight out");
    enqueue({ accountId, type: "export_ae", payload: { clipId: clip.id }, maxAttempts: 5 });
    return;
  }

  noteProgress(clip.id, `Review it in After Effects, then export to ${outcome.exportDir}`);
  notify({
    accountId,
    level: "success",
    type: "clip.review_in_ae",
    title: "Ready to review in After Effects",
    body: `${hook} - ${Math.round(outcome.durationSec)}s, comp ${outcome.comp}.${postBy(clip)} Export into the clip's export folder when you are happy with it.`,
    meta: { clipId: clip.id, ...outcome },
  });
}

/**
 * The narration as written, for a clip whose voice-over we wrote. Whisper heard
 * "fissile core" as "thistle core" and it went on screen; with the script the
 * transcript takes our words and keeps only Whisper's timing.
 */
function spokenText(script: string | null): string | null {
  if (!script) return null;
  try {
    const lines = JSON.parse(script) as { text?: string }[];
    return lines.map((l) => l.text ?? "").filter(Boolean).join(" ") || null;
  } catch {
    return null;
  }
}

/** Moves exports older than a build into export/superseded/. */
function supersedeExports(clipId: string, builtAtMs: number) {
  const dir = aeExportDir(clipId);
  if (!fs.existsSync(dir) || !Number.isFinite(builtAtMs)) return;
  const old = fs.readdirSync(dir)
    .filter((f) => /\.(mp4|mov)$/i.test(f))
    .filter((f) => fs.statSync(path.join(dir, f)).mtimeMs < builtAtMs);
  if (!old.length) return;
  const to = path.join(dir, "superseded");
  fs.mkdirSync(to, { recursive: true });
  for (const f of old) fs.renameSync(path.join(dir, f), path.join(to, `${Date.now()}-${f}`));
}

/**
 * Renders a built edit with no one reviewing it, then marks the clip ready.
 *
 * Thrown failures retry through the job's backoff; After Effects being closed
 * is a wait, not a failure, and is put back on the queue like edit_ae does.
 */
export async function exportInAe(accountId: string, payload: { clipId: string }) {
  const clip = db.select().from(clips).where(eq(clips.id, payload.clipId)).get();
  if (!clip) throw new Error(`No clip ${payload.clipId}`);
  if (clip.status !== "review_in_ae") return;

  const existing = newestAeExport(clip.id);
  if (existing) {
    await markExported(clip, existing);
    return;
  }

  noteProgress(clip.id, "Rendering the edit in After Effects");
  const outcome = await runAeExport({
    clipId: clip.id,
    onProgress: (message) => noteProgress(clip.id, message),
  });

  if (outcome.status === "waiting_for_ae") {
    noteProgress(clip.id, outcome.message);
    enqueue({
      accountId,
      type: "export_ae",
      payload,
      runAt: new Date(Date.now() + env.aeRetryMinutes * 60_000),
      maxAttempts: 5,
    });
    return;
  }
  if (outcome.status === "failed") throw new Error(outcome.error);

  await markExported(clip, outcome.file);
}

/**
 * A finished video is in the clip's export folder: mark the clip ready, and
 * queue its post when it was made for a slot.
 */
async function markExported(clip: typeof clips.$inferSelect, file: string) {
  const info = await probe(file);
  if (!info.durationSec) throw new Error(`${file} has no duration - not a finished video`);

  // A missing preview image must never cost a finished video.
  let thumb: string | null = null;
  try {
    thumb = await extractThumbnail(file, clip.id);
  } catch {
    thumb = null;
  }

  setStatus(clip.id, "ready", {
    outputPath: file,
    thumbnailPath: thumb,
    outputDurationSec: info.durationSec,
    sizeBytes: info.sizeBytes,
    error: null,
  });
  noteProgress(clip.id, `Export picked up - ${Math.round(info.durationSec)}s, ready to post`);
  notify({
    accountId: clip.accountId,
    level: "success",
    type: "clip.exported",
    title: "Export picked up",
    body: `${clip.hookText || clip.sourceTitle || "Clip"} - ${Math.round(info.durationSec)}s, caption and hashtags attached.${postBy(clip)}`,
    meta: { clipId: clip.id, path: file },
  });
  if (isApproved(clip.id)) {
    // Approved in review: out now, to its own account, through the phone.
    enqueue({ accountId: clip.accountId, type: "post_now", payload: { clipId: clip.id }, maxAttempts: 3 });
    noteProgress(clip.id, "Approved - posting now");
    return;
  }
  // The owner reviews every video before it goes out (decided 2026-09-30).
  // With AE_AUTO_EXPORT on, an edit exports unattended - so an export alone
  // must never post, autopilot slot or not. It waits for `npm run approve`.
  noteProgress(clip.id, `Waiting for your OK - watch ${file}, then: npm run approve -- ${clip.id}`);
  // Or from the phone: the video with Approve / Reject under it.
  await sendForReview(clip, file, info.durationSec);
}

/**
 * Last size seen for each export file.
 *
 * After Effects writes an export in place, so a file is only taken once its
 * size has held still across two worker ticks - otherwise a half-written video
 * would be marked ready.
 */
const seenSize = new Map<string, number>();

/** Picks up videos exported from After Effects and marks their clips ready. */
export async function collectAeExports() {
  const reviewing = db.select().from(clips).where(eq(clips.status, "review_in_ae")).all();

  for (const clip of reviewing) {
    try {
      const dir = aeExportDir(clip.id);
      if (!fs.existsSync(dir)) continue;

      const newest = fs
        .readdirSync(dir)
        .filter((f) => /\.(mp4|mov)$/i.test(f))
        .map((f) => {
          const full = path.join(dir, f);
          return { full, stat: fs.statSync(full) };
        })
        .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0];
      if (!newest || newest.stat.size < 10_000) continue;

      if (seenSize.get(newest.full) !== newest.stat.size) {
        seenSize.set(newest.full, newest.stat.size);
        continue;
      }

      seenSize.delete(newest.full);
      await markExported(clip, newest.full);
    } catch {
      // Still being written, or locked by After Effects. The next tick looks again.
    }
  }
}
