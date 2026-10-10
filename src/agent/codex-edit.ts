import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clips } from "@/db/schema";
import { runCodexEditor } from "@/lib/codex-editor";
import { extractThumbnail, probe } from "@/lib/media";
import { mediaDir } from "@/lib/media";
import { logEvent, noteProgress } from "./events";
import { schedulePublish } from "./publish";

export type CodexEditPayload = { clipId: string; sourcePath: string };

/** Render a finished MP4 and queue its handoff to Claude. */
export async function editInCodex(accountId: string, payload: CodexEditPayload): Promise<void> {
  const clip = db.select().from(clips).where(eq(clips.id, payload.clipId)).get();
  if (!clip) throw new Error(`No clip ${payload.clipId}`);
  if (clip.status === "ready") { schedulePublish(clip.id); return; }
  if (clip.status === "posted") return;
  if (!fs.existsSync(payload.sourcePath)) throw new Error(`Downloaded source missing: ${payload.sourcePath}`);

  const rendered = await runCodexEditor({
    clipId: clip.id,
    sourcePath: payload.sourcePath,
    hook: clip.hookText ?? "",
    caption: clip.caption ?? "",
    onProgress: (message) => noteProgress(clip.id, message),
  });
  const rejectRender = (reason: string): never => {
    try { fs.renameSync(rendered, `${rendered}.invalid-${Date.now()}`); } catch { /* preserve the original error */ }
    throw new Error(`${reason}: ${rendered}`);
  };
  const info = await probe(rendered).catch((error: unknown) =>
    rejectRender(`Codex result cannot be probed (${String(error)})`),
  );
  const source = await probe(payload.sourcePath);
  if (!info.hasAudio || info.width <= 0 || info.height <= info.width || info.durationSec < 8) {
    rejectRender("Codex result is not a complete vertical video with audio");
  }
  if (source.durationSec > 0 && info.durationSec < source.durationSec * 0.75) {
    rejectRender(`Codex result is too short (${info.durationSec}s vs ${source.durationSec}s source)`);
  }

  const dir = path.join(mediaDir, "codex", clip.id);
  fs.mkdirSync(dir, { recursive: true });
  const outputPath = path.join(dir, "final.mp4");
  const pending = path.join(dir, "final.pending.mp4");
  fs.copyFileSync(rendered, pending);
  fs.renameSync(pending, outputPath);
  let thumbnailPath: string | null = null;
  try { thumbnailPath = await extractThumbnail(outputPath, clip.id); } catch { /* video stays usable */ }

  db.update(clips).set({
    status: "ready", outputPath, thumbnailPath,
    outputDurationSec: info.durationSec, sizeBytes: fs.statSync(outputPath).size,
    error: null,
  }).where(eq(clips.id, clip.id)).run();
  noteProgress(clip.id, `Codex video finished: ${Math.round(info.durationSec)}s; preparing Claude handoff`);
  logEvent({ accountId, type: "clip.codex_ready", message: `Codex rendered ${clip.hookText ?? clip.id}` });
  schedulePublish(clip.id);
}
