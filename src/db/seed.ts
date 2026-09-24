/**
 * Creates one account and its agent. Everything else - niche, content profile,
 * metrics, videos - is derived from the account's own data on first sync.
 *
 *   npm run db:seed -- sciencelabaratory
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import { accounts, agents } from "./schema";

const handle = (process.argv[2] ?? "sciencelabaratory").replace(/^@/, "");

const existing = db.select().from(accounts).where(eq(accounts.handle, handle)).get();
if (existing) {
  console.log(`@${handle} already exists (${existing.id})`);
} else {
  const account = db
    .insert(accounts)
    .values({
      handle,
      displayName: handle,
      targetCountry: "US",
      timezone: "America/New_York",
      status: "active",
    })
    .returning()
    .get();

  db.insert(agents)
    .values({
      accountId: account.id,
      name: "Nova",
      persona:
        "Direct and data-driven. Reports what the numbers say before offering an opinion. Never pads a reply.",
      status: "active",
    })
    .run();

  console.log(`+ @${handle} -> agent "Nova" (${account.id})`);
  console.log('Run "npm run sync" to pull videos and have the agent read the account.');
}
