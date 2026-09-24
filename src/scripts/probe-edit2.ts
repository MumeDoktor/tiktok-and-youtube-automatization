/**
 * A/B probe for the new sound design, without touching the database.
 *
 * Takes any narration audio (or synthesises a short one), builds the same
 * edit twice - old-style two-layer mix versus the new soundtrack with SFX and
 * a ducked bed - and renders both so they can be compared by ear.
 *
 *   npm run probe:edit2 -- media/raw/some-clip.mp4
 *
 * With no argument it uses whatever mp4 sits in media/raw first.
 */
import "../worker/load-env";

import fs from "node:fs";
import path from "node:path";

import { rawDir, outDir } from "../lib/media";
import { buildSoundtrack, planSoundDesign } from "../lib/mix";
import { renderClip } from "../lib/remotion";
import { speak } from "../lib/tts";
import type { TimedHit } from "../lib/look";

const DEMO_LINES = [
  { text: "In 1976, a Soviet pilot looked at a runway and made a choice.", intent: "open" as const },
  { text: "He was supposed to be flying routine patrol near the border.", intent: "escalate" as const },
  { text: "Instead he dropped to fifty feet and crossed it at full throttle.", intent: "escalate" as const },
  { text: "For forty minutes the largest air force on earth chased one man.", intent: "turn" as const },
  { text: "And when he landed, he pulled the lever that grounded an entire fleet.", intent: "payoff" as const },
];

const DEMO_HITS: Array<{ line: number; word: string; effect: TimedHit["effect"]; intensity: number }> = [
  { line: 2, word: "throttle", effect: "punch", intensity: 0.8 },
  { line: 4, word: "grounded", effect: "shockwave", intensity: 1 },
];

async function main() {
  const arg = process.argv.slice(2).join(" ").trim();
  const footagePath = arg && fs.existsSync(arg)
    ? arg
    : fs.readdirSync(rawDir).filter((f) => f.endsWith(".mp4")).map((f) => path.join(rawDir, f))[0];
  if (!footagePath || !fs.existsSync(footagePath)) {
    console.error("No footage found. Pass a path or drop an mp4 into media/raw.");
    process.exit(1);
  }

  console.log(`\n  footage ${footagePath}`);
  console.log("  speaking demo narration...");
  const narration = await speak("probe-edit2", DEMO_LINES);
  console.log(`  narration ${(narration.durationMs / 1000).toFixed(1)}s`);

  // One shared TIMELINE, but a different scene per line - the point is to
  // show how varied scenes read against the narration. Scenes come from
  // whatever distinct clips sit in media/raw, cycled only if there are more
  // shots than files.
  const sceneFiles = fs
    .readdirSync(rawDir)
    .filter((f) => f.endsWith(".mp4"))
    .sort()
    .map((f) => path.join(rawDir, f));
  const sceneCount = Math.min(sceneFiles.length, DEMO_LINES.length);
  console.log(`  scenes: ${sceneCount} file(s) from media/raw`);

  const span = narration.durationMs;
  const perLine = span / DEMO_LINES.length;
  const moves = ["push", "driftL", "pull", "hold"] as const;
  const transitions = ["cut", "whipL", "glide", "zoomBlur"] as const;
  const shots = DEMO_LINES.flatMap((_, i) =>
    [0, 1].map((k) => ({
      // Each line gets its own scene; the two half-line cuts within a line
      // stay on that scene but differ in move, like real coverage would.
      path: sceneFiles[(i + k) % Math.max(1, sceneCount)] ?? footagePath,
      startMs: i * perLine + k * (perLine / 2),
      endMs: i * perLine + (k + 1) * (perLine / 2),
      move: moves[(i * 2 + k) % 4],
      transition: (i === 0 && k === 0 ? "cut" : transitions[(i * 2 + k) % 4]) as
        | "cut"
        | "whipL"
        | "glide"
        | "zoomBlur",
      transitionMs: 0,
      whatIsVisible: "demo",
    })),
  );

  // Resolve the demo hits against real word timings.
  const words = narration.words.map((w) => ({ text: w.text, atMs: w.startMs }));
  const hits: TimedHit[] = [];
  for (const h of DEMO_HITS) {
    const match =
      words.find((w) => w.text.toLowerCase().replace(/[^a-z0-9]/g, "") === h.word.toLowerCase()) ??
      null;
    if (match) hits.push({ atMs: match.atMs, effect: h.effect, intensity: h.intensity });
  }
  console.log(`  effects resolved: ${hits.map((h) => `${h.effect}@${Math.round(h.atMs)}ms`).join(", ")}`);

  // Variant A: raw narration only - what the pipeline did before.
  const aOut = await renderClip("probe-edit2-A", {
    shots,
    words: narration.words,
    lines: narration.lines,
    hookText: "HE STOLE A MIG-25",
    voicePath: narration.audioPath,
    durationMs: narration.durationMs,
    hits,
    look: {
      captions: "kinetic",
      hookExit: 2,
      accent: "#E0A526",
      grade: "archive",
      chrome: ["grain"],
      stamps: [],
    },
  });
  console.log(`\n  A (old mix)     ${aOut}`);

  // Variant B: new soundtrack - SFX on cuts/hits plus humanized silences in
  // the narration itself (speak() now jitters them).
  const sound = planSoundDesign(shots, hits, "probe-edit2-B");
  console.log(`  B sound events: ${sound.map((s) => `${s.kind}@${Math.round(s.atMs)}ms`).join(", ") || "none"}`);
  const mixed = await buildSoundtrack(
    "probe-edit2-B",
    { narrationPath: narration.audioPath, musicPath: null, seed: "probe-edit2-B" },
    sound,
  );
  const bOut = await renderClip("probe-edit2-B", {
    shots,
    words: narration.words,
    lines: narration.lines,
    hookText: "HE STOLE A MIG-25",
    voicePath: mixed,
    durationMs: narration.durationMs + 700,
    hits,
    look: {
      captions: "kinetic",
      hookExit: 2,
      accent: "#E0A526",
      grade: "archive",
      chrome: ["grain"],
      stamps: [],
    },
  });
  console.log(`  B (new mix)     ${bOut}`);
  console.log(`\n  Both in ${outDir}\n`);
}

main();
