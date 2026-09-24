/**
 * Speaks a short script and reports the timings the edit would be cut against.
 * Verifies edge-tts is installed and emitting word boundaries.
 */
import "../worker/load-env";
import { speak, type ScriptLine } from "../lib/tts";

const LINES: ScriptLine[] = [
  { text: "Nineteen sixty two. The President sails out to watch the fleet.", intent: "open" },
  { text: "The whole show rides on kids in colored jerseys.", intent: "escalate" },
  { text: "They can't hear a word anyone says. Hand signals only.", intent: "turn" },
  { text: "Four seconds each. Get it wrong once and you're gone.", intent: "payoff" },
];

async function main() {
  const started = Date.now();
  const n = await speak("ttsprobe", LINES);
  console.log(`\n  track     ${n.audioPath}`);
  console.log(`  duration  ${(n.durationMs / 1000).toFixed(2)}s   (synth took ${((Date.now() - started) / 1000).toFixed(1)}s)`);
  console.log(`  words     ${n.words.length}\n`);
  for (const line of n.lines) {
    console.log(`  [${line.intent.padEnd(6)}] ${(line.startMs / 1000).toFixed(2)}s - ${(line.endMs / 1000).toFixed(2)}s  ${line.text}`);
  }
  console.log("\n  first words:");
  for (const w of n.words.slice(0, 8)) {
    console.log(`    ${(w.startMs / 1000).toFixed(2)}s  ${w.text}`);
  }
  const last = n.words[n.words.length - 1];
  console.log(`  last word: ${last.text} ends ${(last.endMs / 1000).toFixed(2)}s (track ${(n.durationMs / 1000).toFixed(2)}s)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
