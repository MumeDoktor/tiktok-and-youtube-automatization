/**
 * Renders every transition back to back against real footage.
 *
 * Isolated from the agent on purpose: the pipeline takes five minutes and
 * three model calls to reach the renderer, which is far too slow a loop for
 * judging whether a whip pan looks like a whip pan.
 */
import "../worker/load-env";

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_LOOK, type Transition } from "../lib/look";
import { rawDir } from "../lib/media";
import { renderClip } from "../lib/remotion";

const ORDER: Transition[] = [
  "cut",
  "glide",
  "dissolve",
  "whipL",
  "whipR",
  "zoomBlur",
  "flash",
  "dipToBlack",
];

const MS: Record<Transition, number> = {
  cut: 0,
  dissolve: 420,
  glide: 520,
  whipL: 360,
  whipR: 360,
  zoomBlur: 440,
  flash: 200,
  dipToBlack: 440,
};

async function main() {
  // An optional prefix, because judging a blend needs two shots that look
  // different - two frames of the same jet prove nothing.
  const prefix = process.argv[2] ?? "";
  const pool = fs
    .readdirSync(rawDir)
    .filter((f) => f.includes("-shot") && f.endsWith(".mp4") && f.startsWith(prefix))
    .sort()
    .map((f) => path.join(rawDir, f));

  if (pool.length === 0) {
    console.error("No shot files in media/raw. Run npm run probe:edit first.");
    process.exit(1);
  }

  // Each shot runs three seconds, so the blend at its head is easy to find.
  const SHOT_MS = 3000;
  const shots = ORDER.map((transition, i) => ({
    path: pool[i % pool.length],
    startMs: i * SHOT_MS,
    endMs: (i + 1) * SHOT_MS,
    move: (i % 2 === 0 ? "push" : "pull") as "push" | "pull",
    transition,
    transitionMs: MS[transition],
  }));

  console.log("\n  transition schedule:");
  shots.forEach((s, i) => {
    console.log(
      `    ${String(i).padStart(2)}  ${s.transition.padEnd(11)} at ${(s.startMs / 1000).toFixed(1)}s  (${s.transitionMs}ms)  ${path.basename(s.path)}`,
    );
  });

  const out = await renderClip("transtest", {
    shots,
    words: [],
    lines: [],
    hookText: "",
    durationMs: ORDER.length * SHOT_MS,
    look: { ...DEFAULT_LOOK, captions: "none", chrome: [] },
  });

  console.log(`\n  rendered ${out}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
