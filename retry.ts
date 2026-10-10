import "./src/worker/load-env";
import { db } from "@/db";
import { clips } from "@/db/schema";
import { eq } from "drizzle-orm";
import { makeClip } from "@/agent/clip";

async function main() {
  const clip = db.select().from(clips).all()[0];
  if (!clip) { console.log("no clip row to retry"); return; }
  console.log(`retrying ${clip.id}: ${clip.sourceTitle}`);
  console.log(`segment ${clip.startSec}s -> ${clip.endSec}s\n`);
  const t0 = Date.now();
  await makeClip(clip.accountId, clip.id);
  const row = db.select().from(clips).where(eq(clips.id, clip.id)).get();
  console.log(`\nfinished in ${((Date.now()-t0)/60000).toFixed(1)} min`);
  console.log(`status: ${row?.status}`);
  console.log(`output: ${row?.outputPath ?? "-"}`);
  console.log(`length: ${row?.outputDurationSec ? Math.round(row.outputDurationSec)+"s" : "-"}  size: ${row?.sizeBytes ? (row.sizeBytes/1e6).toFixed(1)+"MB" : "-"}`);
  console.log(`error:  ${row?.error ?? "none"}`);
}
void main().catch(e => { console.error("THREW:", e instanceof Error ? e.message : e); process.exit(1); });
