/**
 * Inspects SocialCrawl's real response so the field mapping can be verified.
 *
 *   npm run probe:socialcrawl -- sciencelabaratory
 *
 * Prints the response shape and what the normaliser made of it, without
 * writing anything to the database.
 */
import "../worker/load-env";

import { fetchProfileVideos, rawProfileVideos } from "../lib/socialcrawl";

function shapeOf(value: unknown, depth = 0): string {
  const pad = "  ".repeat(depth + 1);
  if (Array.isArray(value)) {
    return value.length === 0
      ? "[] (empty)"
      : `array of ${value.length}, first item keys:\n${pad}${Object.keys(
          value[0] as object,
        ).join(", ")}`;
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => {
        const kind = Array.isArray(v)
          ? `array(${v.length})`
          : v === null
            ? "null"
            : typeof v;
        return `${pad}${k}: ${kind}`;
      })
      .join("\n");
  }
  return typeof value;
}

async function main() {
  const handle = process.argv[2]?.replace(/^@/, "");
  if (!handle) {
    console.error("\n  Usage: npm run probe:socialcrawl -- <handle>\n");
    process.exit(1);
  }

  if (!process.env.SOCIALCRAWL_API_KEY) {
    console.error("\n  SOCIALCRAWL_API_KEY is not set in .env.local\n");
    process.exit(1);
  }

  console.log(`\n  Probing @${handle}\n  ${"-".repeat(60)}`);

  let raw: unknown;
  try {
    raw = await rawProfileVideos(handle);
  } catch (err) {
    console.error(`\n  Request failed: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }

  console.log("\n  TOP-LEVEL SHAPE");
  console.log(shapeOf(raw));

  // Show one full video object so every available field is visible.
  const container = raw as Record<string, unknown>;
  const arr =
    (Array.isArray(raw) && raw) ||
    (Array.isArray(container.videos) && container.videos) ||
    (Array.isArray(container.data) && container.data) ||
    (Array.isArray(container.items) && container.items) ||
    null;

  if (arr && arr.length) {
    console.log("\n  FIRST VIDEO, RAW");
    console.log(JSON.stringify(arr[0], null, 2).slice(0, 2500));
  } else {
    console.log("\n  No obvious video array at the top level. Full payload head:");
    console.log(JSON.stringify(raw, null, 2).slice(0, 2500));
  }

  console.log("\n  NORMALISED");
  try {
    const profile = await fetchProfileVideos(handle);
    console.log(`    handle:     @${profile.handle}`);
    const show = (v: number | null) =>
      v === null ? "not reported by this endpoint" : v.toLocaleString();
    console.log(`    followers:  ${show(profile.followers)}`);
    console.log(`    likes:      ${show(profile.likes)}`);
    console.log(`    videoCount: ${profile.videoCount ?? "unknown"}`);
    console.log(`    credits:    ${profile.creditsUsed} used, ${profile.creditsRemaining ?? "?"} left`);
    console.log(`    videos:     ${profile.videos.length} parsed`);
    console.log("\n    Top 5 by views:");
    for (const v of [...profile.videos].sort((a, b) => b.views - a.views).slice(0, 5)) {
      console.log(
        `      ${v.views.toLocaleString().padStart(10)} views  ` +
          `${v.likes.toLocaleString().padStart(8)} likes  ` +
          `${String(v.comments).padStart(5)} c  ${String(v.shares).padStart(5)} s  ` +
          `${String(v.saves).padStart(5)} sv  ` +
          `${v.durationSec ? `${v.durationSec.toFixed(0)}s` : "  ?"}  ` +
          `${v.createdAt ? v.createdAt.toISOString().slice(0, 10) : "no date"}  ` +
          `${v.pinned ? "PIN " : ""}${(v.description || "(no caption)").slice(0, 36)}`,
      );
      console.log(`                 ${v.url}`);
    }

    const zeroViews = profile.videos.filter((v) => v.views === 0).length;
    const noDate = profile.videos.filter((v) => !v.createdAt).length;
    if (zeroViews || noDate) {
      console.log(
        `\n    WARNING: ${zeroViews} video(s) parsed with 0 views, ${noDate} with no date.` +
          "\n    That usually means a field name is not mapped - paste the raw output above to fix it.",
      );
    }
  } catch (err) {
    console.error(`    Normaliser failed: ${err instanceof Error ? err.message : err}`);
  }

  console.log();
}

void main();
