import fs from "node:fs";
import path from "node:path";

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { clips, settings } from "@/db/schema";
import { probe, upscaleVertical } from "@/lib/media";
import type { AeEditPayload } from "./ae-edit";
import { enqueue, logEvent, noteProgress } from "./events";

/**
 * A folder of finished clips an account posts from.
 *
 * Some accounts are fed from a local library rather than from a search - a
 * folder of already-edited shorts, captions and watermark burned in. Nothing
 * here decides what the account IS; it picks the next clip it has not posted,
 * the one most like what has already worked on it, and sends it to After
 * Effects for motion (captions are already in the picture, so motion only).
 *
 * Configured per account in the settings table:
 *   library_dir:<accountId>     the folder
 *   library_share:<accountId>   share of made videos drawn from it (0-1, default 0.75)
 */

const STOP = new Set([
  "this", "that", "with", "from", "they", "their", "what", "when", "your", "about", "have",
  "were", "will", "just", "into", "than", "then", "them", "there", "these", "those", "military",
  "podcast", "shorts", "show", "usarmy", "army",
]);

function setting(key: string, accountId: string): string | null {
  const row = db.select().from(settings).where(eq(settings.key, `${key}:${accountId}`)).get();
  return row?.value ?? null;
}

export function libraryDir(accountId: string): string | null {
  const dir = setting("library_dir", accountId);
  return dir && fs.existsSync(dir) ? dir : null;
}

export function libraryShare(accountId: string): number {
  const raw = setting("library_share", accountId);
  // Number(null) is 0: an unset share must mean the default, not "never".
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.75;
}

const words = (s: string) =>
  s.toLowerCase().replace(/#\S+/g, " ").replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w));

/** The title a file carries, without its hashtags or extension. */
export function titleOf(file: string): string {
  return path.basename(file).replace(/\.[^.]+$/, "").replace(/#\S+/g, "").replace(/\s+/g, " ").trim();
}

/** Hashtags the file name carries, as the clip's own. */
function tagsOf(file: string): string[] {
  return [...path.basename(file).matchAll(/#(\w+)/g)].map((m) => m[1].toLowerCase());
}

/**
 * Whether a clip has already gone out, by title overlap with the account's
 * posts, or already been taken from the library by an earlier make.
 */
function usedTitles(accountId: string) {
  const posted = db.all<{ caption: string | null }>(sql`
    SELECT caption FROM posts WHERE account_id = ${accountId}
  `).map((r) => new Set(words(r.caption ?? "")));
  const taken = new Set(
    db.select({ url: clips.sourceUrl }).from(clips)
      .where(and(eq(clips.accountId, accountId))).all().map((r) => path.resolve(r.url || "")),
  );
  return (file: string) => {
    if (taken.has(path.resolve(file))) return true;
    const w = new Set(words(titleOf(file)));
    if (!w.size) return false;
    return posted.some((p) => {
      let n = 0;
      for (const x of w) if (p.has(x)) n++;
      return n / w.size >= 0.6;
    });
  };
}

/**
 * Word weights from what performed: each word of a post's caption earns the
 * log of that post's views. Not a topic list anyone wrote - the account's own
 * record of what its audience watches.
 */
function interestWeights(accountId: string): Map<string, number> {
  const rows = db.all<{ caption: string | null; views: number }>(sql`
    SELECT p.caption AS caption, COALESCE(m.views, 0) AS views
    FROM posts p
    LEFT JOIN (
      SELECT post_id, MAX(captured_at) AS at FROM post_metrics GROUP BY post_id
    ) newest ON newest.post_id = p.id
    LEFT JOIN post_metrics m ON m.post_id = p.id AND m.captured_at = newest.at
    WHERE p.account_id = ${accountId}
  `);
  const weights = new Map<string, number>();
  for (const r of rows) {
    const w = Math.log10(1 + (r.views ?? 0));
    for (const word of new Set(words(r.caption ?? ""))) weights.set(word, (weights.get(word) ?? 0) + w);
  }
  return weights;
}

/** The unposted clip most like the account's winners; a little random among the best. */
export function pickLibraryClip(accountId: string): { file: string; score: number } | null {
  const dir = libraryDir(accountId);
  if (!dir) return null;
  const used = usedTitles(accountId);
  const weights = interestWeights(accountId);
  const scored = fs.readdirSync(dir)
    .filter((f) => /\.(mp4|mov)$/i.test(f))
    .map((f) => path.join(dir, f))
    .filter((f) => !used(f))
    .map((file) => {
      const w = words(titleOf(file));
      const score = w.reduce((s, x) => s + (weights.get(x) ?? 0), 0) / Math.sqrt(w.length || 1);
      return { file, score };
    })
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  // Top three, so a folder does not always yield the same "best" clip twice
  // in a row after a sync nudges the weights.
  return scored[Math.floor(Math.random() * Math.min(3, scored.length))];
}

/**
 * Takes the next library clip for an account and queues it for After Effects.
 * Returns the clip id, or null when the folder has nothing left to post.
 */
export async function makeLibraryClip(
  accountId: string,
  { scheduledFor }: { scheduledFor?: Date } = {},
): Promise<string | null> {
  const pick = pickLibraryClip(accountId);
  if (!pick) {
    logEvent({ accountId, level: "warn", type: "library.empty", message: "Nothing unposted left in the library folder" });
    return null;
  }
  const info = await probe(pick.file);
  const title = titleOf(pick.file);
  const tags = [...new Set([...tagsOf(pick.file), "military", "history"])].slice(0, 5);

  const clip = db.insert(clips).values({
    accountId,
    sourceType: "url",
    sourceUrl: pick.file,
    sourceTitle: title,
    status: "queued",
    hookText: title,
    caption: title,
    hashtags: JSON.stringify(tags),
    rationale: `From the library folder (unposted). Chosen as most like this account's best-performing posts (score ${pick.score.toFixed(1)}).`,
    scheduledFor: scheduledFor ?? null,
  } as never).returning().get() as { id: string };

  noteProgress(clip.id, `Picked "${title}" (${Math.round(info.durationSec)}s) from the library`);
  const source = await upscaleVertical(pick.file, clip.id);
  if (source !== pick.file) noteProgress(clip.id, `Upscaled from ${info.width}x${info.height} to full HD before editing`);
  const payload: AeEditPayload = {
    clipId: clip.id,
    sourcePath: source,
    targetSec: Math.ceil(info.durationSec),
    // Captions and titles are already burned into a library clip: a second
    // caption track would double them. The source is the finished story.
    keepAll: true,
    motionOnly: true,
    appetite: 1.8,
  };
  enqueue({ accountId, type: "edit_ae", payload });
  logEvent({ accountId, type: "library.picked", message: `Library clip queued for After Effects: ${title}` });
  return clip.id;
}
