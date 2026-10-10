/**
 * Make one video for an account now.
 *
 *   npm run make -- norex055            queue it for the worker (npm run dev)
 *   npm run make -- sciencelabaratory --now   run it here, in the foreground
 *
 * It ends at review in After Effects. Look at it, then: npm run approve -- <clipId>
 *
 * A long-form (12-16 minute, 16:9) aviation-accident documentary for YouTube instead:
 *
 *   npm run make -- norex055 --long                                 the agent picks the accident
 *   npm run make -- norex055 --long "British Airways Flight 5390"   you pick it
 *   npm run make -- norex055 --long --resume <clipId>    carry on one that stopped
 */
import "../worker/load-env";

import { db } from "../db/index";
import { accounts } from "../db/schema";
import { enqueue } from "../agent/events";
import { makeVideo } from "../agent/make";
import { makeLongVideo } from "../agent/long";

async function main() {
  const handle = process.argv[2]?.replace(/^@/, "");
  const now = process.argv.includes("--now");
  const account = db.select().from(accounts).all().find((a) => a.handle === handle || a.id === handle);
  if (!account) {
    console.error(`usage: npm run make -- <handle> [--now]   (accounts: ${db.select().from(accounts).all().map((a) => a.handle).join(", ")})`);
    process.exit(1);
  }
  if (process.argv.includes("--long")) {
    const args = process.argv.slice(3);
    const at = args.indexOf("--resume");
    const clipId = at >= 0 ? args[at + 1] : undefined;
    const topic = args.filter((a, i) => !a.startsWith("--") && !(at >= 0 && i === at + 1)).join(" ").trim() || null;
    if (at >= 0 && !clipId) throw new Error("--resume needs the clip id");
    if (!now) {
      // One attempt: a retry would start a second film. A video that stopped is resumed by hand.
      enqueue({ accountId: account.id, type: "make_long", payload: { topic, clipId }, maxAttempts: 1 });
      console.log(`Queued a long video for @${account.handle}${topic ? `: ${topic}` : ""}. It takes a couple of hours; it arrives in Telegram for review.`);
      return;
    }
    console.log(`Making a long video for @${account.handle} ...`);
    const id = await makeLongVideo(account.id, { topic, clipId });
    console.log(`Long video ${id} is ready.`);
    return;
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
