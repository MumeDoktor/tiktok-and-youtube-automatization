/**
 * Make the short version of a story that has already been made.
 *
 *   npm run teaser -- <clipId>
 *
 * Uses the long clip's own film, shots and narration. It ends at review, like
 * every other video: npm run approve -- <newClipId>, or the Telegram buttons.
 */
import "../worker/load-env";

import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { clips } from "../db/schema";
import { makeTeaser } from "../agent/teaser";
import type { FilmMoment } from "../agent/shots";

async function main() {
  const clipId = process.argv[2];
  const clip = clipId ? db.select().from(clips).where(eq(clips.id, clipId)).get() : undefined;
  if (!clip) {
    console.error("usage: npm run teaser -- <clipId>   (a narrated archive story; see npm run review)");
    process.exit(1);
  }

  let shots: Array<{ atSec: number; whatIsVisible: string }> = [];
  let lines: Array<{ text: string }> = [];
  try {
    shots = JSON.parse(clip.shots ?? "[]");
    lines = JSON.parse(clip.script ?? "[]");
  } catch {
    // Reported just below.
  }
  if (!shots.length || !lines.length || !/^https?:/.test(clip.sourceUrl)) {
    console.error(`Clip ${clip.id} is not a narrated archive story - it has no film, shots or narration to make a short from.`);
    process.exit(1);
  }

  // The stored shot list keeps what each moment shows but not how it moved.
  const seen = new Set<number>();
  const moments: FilmMoment[] = shots
    .filter((s) => (seen.has(s.atSec) ? false : (seen.add(s.atSec), true)))
    .map((s) => ({ atSec: s.atSec, whatIsVisible: s.whatIsVisible, energy: "moving" as const }));

  const id = await makeTeaser(clip.accountId, {
    parentClipId: clip.id,
    angle: clip.hookText ?? clip.caption ?? "",
    narration: lines.map((l) => l.text),
    film: {
      title: clip.sourceTitle ?? "archive film",
      pageUrl: clip.sourceUrl,
      credit: clip.sourceUploader ?? "public domain",
      when: "",
    },
    moments,
  });
  console.log(`Short version ${id} made and sent for review. Approve: npm run approve -- ${id}`);
}

void main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
