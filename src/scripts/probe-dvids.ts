/**
 * Inspects the DVIDS API response so the field mapping can be verified.
 *
 *   npm run probe:dvids -- "F-22 Raptor"
 */
import "../worker/load-env";

import { rawSearch, searchVideos, getAsset } from "../lib/dvids";

async function main() {
  const q = process.argv.slice(2).join(" ") || "F-22 Raptor";

  if (!process.env.DVIDS_API_KEY) {
    console.error(
      "\n  DVIDS_API_KEY is not set.\n" +
        "  Request one by emailing dvidsservicedesk@dvidshub.net, then add it to .env.local\n",
    );
    process.exit(1);
  }

  console.log(`\n  Searching DVIDS for "${q}"\n  ${"-".repeat(60)}`);

  const raw = await rawSearch(q);
  console.log("\n  RAW SHAPE");
  console.log("  top-level keys:", Object.keys(raw).join(", "));
  const results = Array.isArray(raw.results) ? raw.results : [];
  if (results.length) {
    console.log("\n  FIRST RESULT, RAW");
    console.log(JSON.stringify(results[0], null, 2).slice(0, 1800));
  }

  console.log("\n  NORMALISED");
  const assets = await searchVideos(q, { maxResults: 5 });
  console.log(`  ${assets.length} asset(s) parsed\n`);
  for (const a of assets) {
    console.log(`  ${a.id}  ${a.durationSec ? `${Math.round(a.durationSec)}s` : "  ?"}  ${a.title.slice(0, 60)}`);
    console.log(`      ${a.publishedAt?.toISOString().slice(0, 10) ?? "no date"}  ${a.branch ?? ""} ${a.unit ?? ""}`);
    console.log(`      download: ${a.downloadUrl ? "yes" : "NOT IN SEARCH RESULT"}`);
  }

  // The search payload often omits file URLs; the detail endpoint carries them.
  if (assets[0]) {
    console.log(`\n  ASSET DETAIL for ${assets[0].id}`);
    const detail = await getAsset(assets[0].id);
    console.log("      download:", detail?.downloadUrl ?? "still none - check the raw shape above");
    console.log("      duration:", detail?.durationSec ?? "?");
  }
  console.log();
}

void main();
