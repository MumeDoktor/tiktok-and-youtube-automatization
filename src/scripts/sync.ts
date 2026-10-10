/**
 * Syncs one account (or all active ones) from its configured data source.
 *
 *   npm run sync                    # every active account
 *   npm run sync -- sciencelabaratory
 *
 * Useful on its own, and the same code path the worker runs on a schedule.
 */
import "../worker/load-env";

import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { accounts } from "../db/schema";
import { syncAccount } from "../agent/sync";

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--full");
  const full = process.argv.includes("--full");
  const target = args[0]?.replace(/^@/, "");

  const rows = db.select().from(accounts).all();
  const chosen = target
    ? rows.filter((a) => a.handle === target || a.id === target)
    : rows.filter((a) => a.status === "active");

  if (chosen.length === 0) {
    console.error(
      target
        ? `\n  No account matching "${target}".\n`
        : "\n  No active accounts.\n",
    );
    process.exit(1);
  }

  for (const account of chosen) {
    console.log(`\n  Syncing @${account.handle} ...`);
    try {
      const result = await syncAccount(account.id, { full });
      console.log(
        `  Done: ${result.created} new, ${result.updated} updated, ` +
          `${result.profile.videos.length} video(s) total.`,
      );
    } catch (err) {
      console.error(`  FAILED: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    }
  }
  console.log();
}

void main();
