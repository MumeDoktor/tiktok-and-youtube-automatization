/**
 * Fires every word effect in turn against real footage.
 *
 * Effects are the one part of the edit that has to be judged in motion - a
 * shake, a shockwave and a glitch all look like a slightly odd still frame if
 * you only ever sample one. This renders them spaced out so each can be found
 * and watched, without paying five minutes and three model calls per look.
 */
import "../worker/load-env";

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_LOOK, type Effect, type TimedHit } from "../lib/look";
import { rawDir } from "../lib/media";
import { renderClip, type RenderWord } from "../lib/remotion";

const ORDER: Effect[] = [
  "shake",
  "flash",
  "shockwave",
  "punch",
  "rumble",
  "burn",
  "glitch",
  "drop",
];

async function main() {
  const pool = fs
    .readdirSync(rawDir)
    .filter((f) => f.includes("-shot") && f.endsWith(".mp4"))
    .sort()
    .map((f) => path.join(rawDir, f));

  if (pool.length === 0) {
    console.error("No shot files in media/raw. Run npm run probe:edit first.");
    process.exit(1);
  }

  // Three seconds each: long enough for the slowest effect to finish and for
  // the frame to settle before the next one starts.
  const SLOT_MS = 3000;
  const hits: TimedHit[] = ORDER.map((effect, i) => ({
    atMs: i * SLOT_MS + 900,
    effect,
    intensity: 0.85,
  }));

  const words: RenderWord[] = ORDER.map((effect, i) => ({
    text: effect.toUpperCase(),
    startMs: i * SLOT_MS + 700,
    endMs: i * SLOT_MS + 2400,
    line: i,
    emphasis: false,
  }));

  const shots = ORDER.map((_, i) => ({
    path: pool[i % pool.length],
    startMs: i * SLOT_MS,
    endMs: (i + 1) * SLOT_MS,
    move: "hold" as const,
    transition: (i === 0 ? "cut" : "dissolve") as "cut" | "dissolve",
    transitionMs: i === 0 ? 0 : 300,
  }));

  console.log("\n  effect timeline:");
  hits.forEach((h) =>
    console.log(`    ${h.effect.padEnd(10)} fires at ${(h.atMs / 1000).toFixed(1)}s`),
  );

  const out = await renderClip("effecttest", {
    shots,
    words,
    lines: [],
    hookText: "",
    durationMs: ORDER.length * SLOT_MS,
    hits,
    look: { ...DEFAULT_LOOK, chrome: [], grade: "none" },
  });

  console.log(`\n  rendered ${out}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
