/**
 * Make one video for an account now.
 *
 *   npm run make -- norex055            queue it for the worker (npm run dev)
 *   npm run make -- sciencelabaratory --now   run it here, in the foreground
 *
 * It ends at review in After Effects. Look at it, then: npm run approve -- <clipId>
 */
import "../worker/load-env";

import { db } from "../db/index";
import { accounts } from "../db/schema";
import { enqueue } from "../agent/events";
import { makeVideo } from "../agent/make";

async function main() {
  const handle = process.argv[2]?.replace(/^@/, "");
  const now = process.argv.includes("--now");
  const account = db.select().from(accounts).all().find((a) => a.handle === handle || a.id === handle);
  if (!account) {
    console.error(`usage: npm run make -- <handle> [--now]   (accounts: ${db.select().from(accounts).all().map((a) => a.handle).join(", ")})`);
    process.exit(1);
  }
  if (!now) {
    enqueue({ accountId: account.id, type: "make_video" });
    console.log(`Queued a video for @${account.handle}. The worker (npm run dev) makes it; npm run review shows where it is.`);
    return;
  }
  console.log(`Making a video for @${account.handle} ...`);
  const clipId = await makeVideo(account.id);
  console.log(clipId
    ? `Clip ${clipId} started. It is edited in After Effects by the worker, then waits for: npm run approve -- ${clipId}`
    : "Nothing to make.");
}

void main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
