// One-off: export a clip waiting in After Effects right now, outside the
// worker's queue. The queued export_ae then finds it exported and does nothing.
//   npx tsx src/scripts/_export-now.ts <clipId>
import "../worker/load-env";

import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { clips } from "../db/schema";
import { exportInAe } from "../agent/ae-edit";

async function main() {
  const clipId = process.argv[2];
  const clip = db.select().from(clips).where(eq(clips.id, clipId)).get();
  if (!clip) throw new Error(`No clip ${clipId}`);
  await exportInAe(clip.accountId, { clipId });
  const after = db.select().from(clips).where(eq(clips.id, clipId)).get();
  console.log(`${clipId}: ${after?.status} ${after?.outputPath ?? ""}`);
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
