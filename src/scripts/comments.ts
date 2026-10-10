/**
 * Check an account's newest posts for comments now, and draft replies.
 *
 *   npm run comments -- norex055
 *
 * Drafts go to Telegram for a yes (COMMENT_REPLIES=review, the default) or are
 * sent straight away (COMMENT_REPLIES=auto). Nothing is sent with it "off".
 */
import "../worker/load-env";

import { db } from "../db/index";
import { accounts } from "../db/schema";
import { checkComments } from "../agent/comments";
import { env } from "../lib/env";

async function main() {
  const handle = process.argv[2]?.replace(/^@/, "");
  const account = db.select().from(accounts).all().find((a) => a.handle === handle || a.id === handle);
  if (!account) {
    console.error(`usage: npm run comments -- <handle>   (accounts: ${db.select().from(accounts).all().map((a) => a.handle).join(", ")})`);
    process.exit(1);
  }
  console.log(`Reading comments on @${account.handle} (replies: ${env.commentReplies}) ...`);
  const drafted = await checkComments(account.id);
  console.log(`${drafted} repl${drafted === 1 ? "y" : "ies"} drafted.`);
}

void main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
