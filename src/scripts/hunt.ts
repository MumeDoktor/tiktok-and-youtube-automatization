/**
 * Runs one source hunt now, start to finish, in the foreground.
 *
 *   npm run hunt                    # the first active account
 *   npm run hunt -- sciencelabaratory
 *
 * The same code path the worker runs on a schedule, but attached to a terminal
 * so the whole decision is visible while it happens: what it searched for, what
 * it chose, what it declined, and how it cut what was left.
 */
import "../worker/load-env";

import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { accounts, clips } from "../db/schema";
import { producePodcastClips } from "../agent/produce";

async function main() {
  const target = process.argv[2]?.replace(/^@/, "");

  const rows = db.select().from(accounts).all();
  const account = target
    ? rows.find((a) => a.handle === target || a.id === target)
    : rows.find((a) => a.status === "active");

  if (!account) {
    console.error(target ? `No account @${target}` : "No active account. Run: npm run db:seed -- <handle>");
    process.exit(1);
  }

  console.log(`Hunting a source for @${account.handle}...\n`);
  const started = Date.now();

  const result = await producePodcastClips(account.id);
  const mins = ((Date.now() - started) / 60_000).toFixed(1);

  if (!result) {
    console.log(`\nNothing usable found (${mins} min). That is a real outcome, not a failure.`);
    return;
  }

  // Everything cut from this source, including the siblings queued for the
  // worker - the point of the hunt is how many clips one read produced.
  const made = db.select().from(clips).where(eq(clips.accountId, account.id)).all();
  const family = made.filter((c) => c.sourceUrl === result.source.url);

  console.log(`\nDone in ${mins} min. Source: ${result.source.title}`);
  console.log(`${family.length} clip(s) from it:\n`);

  for (const c of family) {
    const where =
      c.startSec !== null ? `${Math.round(c.startSec)}s-${Math.round(c.endSec ?? 0)}s` : "-";
    console.log(`  [${c.status}] ${where}  ${c.hookText || "(no hook yet)"}`);
    if (c.outputPath) console.log(`      ${c.outputPath}`);
    if (c.error) console.log(`      error: ${c.error}`);
  }

  const queued = family.filter((c) => c.status === "queued").length;
  if (queued > 0) {
    console.log(`\n${queued} still queued - start the worker (npm run dev) to render them.`);
  }
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
