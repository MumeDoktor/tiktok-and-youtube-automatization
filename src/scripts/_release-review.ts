// One-off: restore the Telegram chat and send held clips for review.
//   npx tsx src/scripts/_release-review.ts <clipId> [...]
import "../worker/load-env";

import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { clips, settings } from "../db/schema";
import { sendForReview } from "../agent/telegram-review";

async function main() {
  const held = db.select().from(settings).where(eq(settings.key, "telegram:chatId.held")).get();
  if (held) db.update(settings).set({ key: "telegram:chatId" }).where(eq(settings.key, "telegram:chatId.held")).run();
  console.log(held ? "chat restored" : "chat was not held");
  for (const id of process.argv.slice(2)) {
    const clip = db.select().from(clips).where(eq(clips.id, id)).get();
    if (!clip?.outputPath) {
      console.log(`${id}: no export yet`);
      continue;
    }
    await sendForReview(clip, clip.outputPath, clip.outputDurationSec ?? 0);
    console.log(`${id}: sent`);
  }
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
