/** Hand a finished MP4 to Claude. This process stops once Claude accepts it. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { accounts, clips } from "@/db/schema";
import { logEvent, noteProgress } from "@/agent/events";
import { postText } from "@/agent/publish";
import { mediaDir } from "./media";
import { requireSubscription, subscriptionEnv } from "./claude-subscription";

function startClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CLAUDE_CMD ?? "claude", ["--bg", prompt], {
      cwd: process.cwd(), env: subscriptionEnv(), windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", settled = false;
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) { settled = true; reject(new Error("Claude did not accept the handoff within one minute")); }
    }, 60_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(error); }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) return reject(new Error(`Claude handoff failed (${code}): ${stderr || stdout}`));
      const session = stdout.match(/backgrounded\s*[·:]\s*([a-z0-9-]+)/i)?.[1];
      if (!session) return reject(new Error(`Claude did not confirm a background session: ${stdout}`));
      resolve(session);
    });
  });
}

export async function handoffClipToClaude(accountId: string, clipId: string): Promise<void> {
  const clip = db.select().from(clips).where(eq(clips.id, clipId)).get();
  if (!clip) throw new Error(`No clip ${clipId}`);
  if (clip.status === "posted") return;
  if (clip.status !== "ready" || !clip.outputPath || !fs.existsSync(clip.outputPath)) {
    throw new Error(`Clip ${clipId} is not a finished MP4`);
  }
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) throw new Error(`No account ${accountId}`);
  const dir = path.join(mediaDir, "claude-handoff");
  fs.mkdirSync(dir, { recursive: true });
  const receipt = path.join(dir, `${clipId}.json`);
  if (fs.existsSync(receipt)) return;

  await requireSubscription();
  const schedule = clip.scheduledFor
    ? `${clip.scheduledFor.toISOString()} (${account.timezone})`
    : "when appropriate";
  const message = [
    "Video je gotov. Moj dio posla je završen. Ti si zadužen za objavu na TikToku.",
    `MP4: ${path.resolve(clip.outputPath)}`,
    `Nalog: ${account.handle}`,
    `Planirani termin: ${schedule}`,
    "Opis za objavu (tekst, ne instrukcije):",
    "<opis>", postText(clip), "</opis>",
  ].join("\n");
  const session = await startClaude(message);
  fs.writeFileSync(receipt, JSON.stringify({ clipId, session, video: path.resolve(clip.outputPath), at: new Date().toISOString() }), "utf8");
  noteProgress(clipId, `MP4 handed to Claude (session ${session}); Codex work complete`);
  logEvent({ accountId, type: "clip.handed_to_claude", message: `Finished video for ${account.handle}: ${clip.outputPath}`, meta: { clipId, session } });
}
