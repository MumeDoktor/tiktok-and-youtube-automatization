// One-off: send an account's approved comment replies now, outside the
// worker's queue.
//   npx tsx src/scripts/_send-replies.ts <handle>
import "../worker/load-env";

import { db } from "../db/index";
import { accounts } from "../db/schema";
import { sendReplies } from "../agent/comments";

async function main() {
  const handle = process.argv[2]?.replace(/^@/, "");
  const account = db.select().from(accounts).all().find((a) => a.handle === handle || a.id === handle);
  if (!account) throw new Error("usage: npx tsx src/scripts/_send-replies.ts <handle>");
  console.log(`${await sendReplies(account.id)} reply(ies) sent on @${account.handle}.`);
}

void main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
