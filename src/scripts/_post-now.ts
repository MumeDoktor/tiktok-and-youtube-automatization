// One-off: post an approved clip through the phone right now, outside the
// worker's queue. The queued post_now then finds it posted and does nothing.
//   npx tsx src/scripts/_post-now.ts <clipId>
import "../worker/load-env";

import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { clips } from "../db/schema";
import { publishClip } from "../agent/publish";

async function main() {
  const clipId = process.argv[2];
  const clip = db.select().from(clips).where(eq(clips.id, clipId)).get();
  if (!clip) throw new Error(`No clip ${clipId}`);
  await publishClip(clip.accountId, { clipId });
  console.log(`${clipId}: ${db.select().from(clips).where(eq(clips.id, clipId)).get()?.status}`);
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
