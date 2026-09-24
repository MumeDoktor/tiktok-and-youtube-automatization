/**
 * Runs the whole edit pipeline once, without the worker.
 *
 * The worker holds its code in memory, so a pipeline change is invisible to it
 * until it restarts. This runs the new code directly against a real angle so
 * the result can be checked before anything is shipped.
 *
 *   npm run probe:edit -- "aircraft carrier deck crew launching jets"
 */
import "../worker/load-env";

import { eq } from "drizzle-orm";
import { db } from "../db";
import { accounts, clips } from "../db/schema";
import { makeDvidsClip } from "../agent/footage";

async function main() {
  const angle = process.argv.slice(2).join(" ").trim();
  if (!angle) {
    console.error('Give it an angle, e.g. npm run probe:edit -- "carrier deck crew"');
    process.exit(1);
  }

  const account = db.select().from(accounts).limit(1).all()[0];
  if (!account) throw new Error("No account. Run npm run db:seed first.");

  const inserted = db
    .insert(clips)
    .values({
      accountId: account.id,
      sourceType: "dvids",
      // findFootage reads the angle out of this field until a film is chosen.
      sourceUrl: angle,
      hookText: angle,
      status: "queued",
    })
    .returning()
    .get();

  console.log(`\n  clip ${inserted.id}\n  angle: ${angle}\n`);

  const started = Date.now();
  await makeDvidsClip(account.id, inserted.id);

  const done = db.select().from(clips).where(eq(clips.id, inserted.id)).get();
  console.log(`\n  status    ${done?.status}`);
  console.log(`  took      ${((Date.now() - started) / 1000).toFixed(0)}s`);
  if (done?.error) console.log(`  error     ${done.error}`);
  if (done?.outputPath) {
    console.log(`  output    ${done.outputPath}`);
    console.log(`  duration  ${done.outputDurationSec?.toFixed(1)}s`);
    console.log(`  shots     ${JSON.parse(done.shots ?? "[]").length}`);
    console.log(`  words     ${JSON.parse(done.words ?? "[]").length}`);
    console.log(`  caption   ${done.caption}`);
    console.log(`  look      ${done.look}`);
  }
  if (done?.rationale) console.log(`\n  ${done.rationale.slice(0, 400)}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
