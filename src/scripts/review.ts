/**
 * What is being made, what waits for you, and what went out - per account.
 *
 *   npm run review
 */
import "../worker/load-env";

import { desc, eq } from "drizzle-orm";
import { db } from "../db/index";
import { accounts, clips } from "../db/schema";
import { aeRunDir } from "../lib/ae-editor";
import { isApproved } from "../agent/approval";

const WAITING = ["review_in_ae", "ready"];
const WORKING = ["deciding", "queued", "choosing", "looking", "scripting", "voicing", "downloading", "editing", "waiting_for_ae", "transcribing"];

for (const account of db.select().from(accounts).all()) {
  const rows = db.select().from(clips).where(eq(clips.accountId, account.id))
    .orderBy(desc(clips.createdAt)).limit(40).all();
  const waiting = rows.filter((c) => WAITING.includes(c.status));
  const working = rows.filter((c) => WORKING.includes(c.status));
  const posted = rows.filter((c) => c.status === "posted").slice(0, 3);
  console.log(`\n@${account.handle}`);
  if (!waiting.length && !working.length) console.log("  nothing in progress");
  for (const c of waiting) {
    const approved = isApproved(c.id);
    console.log(`  REVIEW  ${c.id}  ${c.status}${approved ? " (approved)" : ""}  ${Math.round(c.outputDurationSec ?? 0)}s  ${c.hookText ?? ""}`);
    console.log(`          ${c.status === "ready" ? c.outputPath : `${aeRunDir(c.id)}\\edit.aep`}`);
    if (!approved) console.log(`          approve:  npm run approve -- ${c.id}`);
  }
  for (const c of working) console.log(`  making  ${c.id}  ${c.status}  ${c.hookText ?? c.sourceUrl ?? ""}`.slice(0, 140));
  for (const c of posted) console.log(`  posted  ${c.id}  ${c.hookText ?? ""}`.slice(0, 140));
}

