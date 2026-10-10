/**
 * Approve a reviewed clip: it is exported (if it is not already) and posted to
 * its own account through the phone, which switches to and verifies it.
 *
 *   npm run approve -- <clipId>
 */
import "../worker/load-env";

import { approveClip } from "../agent/make";

try {
  const id = process.argv[2];
  if (!id) throw new Error("usage: npm run approve -- <clipId>   (npm run review lists them)");
  console.log(`${id}: ${approveClip(id)}. The worker (npm run dev) carries it out.`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
