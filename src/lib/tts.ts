import fs from "node:fs";
import path from "node:path";

import { env } from "./env";
import { ensureDirs, probe, run, splitCmd, voiceDir } from "./media";

/**
 * Turns a written script into a spoken track plus the timings the edit is cut
 * against.
 *
 * The voice track is the spine of the whole video: shot changes, caption
 * timing and the punch-in all come from these numbers rather than from
 * dividing a duration into equal parts. That is the difference between an
 * edit and a slideshow.
 *
 * Lines are synthesised one at a time and then joined with measured pauses.
 * Speaking the whole script in one call is cheaper but gives no control over
 * the silence between sentences, and that silence is most of what makes
 * narration sound deliberate.
 */

export type ScriptLine = {
  text: string;
  /**
   * Drives the pause before the line and the emphasis on its words.
   *
   * These are deliberately not "setup / detail": a slot called detail invites
   * a line whose only job is to be true, and a run of those in the middle of a
   * video is exactly where a viewer leaves.
   */
  intent: "open" | "escalate" | "turn" | "payoff";
};

export type VoiceWord = {
  text: string;
  startMs: number;
  endMs: number;
  /** Which script line this word belongs to. */
  line: number;
  /** True when the line is the payoff, so the composition can hit it. */
  emphasis: boolean;
};

export type VoiceLine = {
  index: number;
  text: string;
  intent: ScriptLine["intent"];
  startMs: number;
  endMs: number;
};

export type Narration = {
  /** The joined track, ready to hand to Remotion. */
  audioPath: string;
  words: VoiceWord[];
  lines: VoiceLine[];
  durationMs: number;
};

/**
 * Silence inserted *before* a line, in ms.
 *
 * A payoff lands harder after a beat of nothing, and a turn needs room to
 * register as a turn. These are the only "direction" the narrator gets.
 */
const LEAD_SILENCE: Record<ScriptLine["intent"], number> = {
  open: 120,
  escalate: 160,
  turn: 380,
  payoff: 520,
};

/**
 * Per-instance jitter around the lead silence, ±25%.
 *
 * The constants above are the right *shape* - payoffs breathe more than opens
 * - but speaking every gap at exactly the same length is itself a tell: the
 * narration acquires a metronome. A deterministic jitter seeded by clip id
 * keeps re-renders identical while no two clips share a rhythm.
 */
function leadSilence(intent: ScriptLine["intent"], id: string, index: number): number {
  const base = LEAD_SILENCE[intent] ?? 160;
  let h = 0;
  const key = `${id}:${index}`;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const factor = 0.75 + ((h % 1000) / 1000) * 0.5; // 0.75 .. 1.25
  return Math.round(base * factor);
}


/** Tail of silence so the last word is not clipped by the container. */
const TAIL_MS = 420;

function silenceArgs(ms: number): string[] {
  // anullsrc rather than a silence file: no asset to ship or keep in sync.
  return ["-f", "lavfi", "-t", (ms / 1000).toFixed(3), "-i", "anullsrc=r=24000:cl=mono"];
}

/**
 * Drops lines until the narration fits the time it is allowed.
 *
 * The writer is given a word budget but is not reliable about it, and length
 * is not a matter of taste here - this account's own numbers put the ceiling
 * around fifty seconds. Detail lines go first, from the middle outwards: the
 * opening has to earn attention and the payoff is the reason the video exists,
 * so neither is ever a candidate.
 */
export function trimToBudget(lines: ScriptLine[], budgetSec: number): ScriptLine[] {
  // Roughly what the narrator will take, including the pauses between lines.
  const cost = (l: ScriptLine) =>
    l.text.trim().split(/\s+/).length / 2.5 + LEAD_SILENCE[l.intent] / 1000;

  const kept = [...lines];
  let total = kept.reduce((sum, l) => sum + cost(l), 0);
  if (total <= budgetSec) return kept;

  // Only escalations are ever cut. The opening plants the question, the turn
  // is the surprise and the payoff is the answer - losing any of those three
  // costs the whole shape of the video, whereas losing a middle beat costs
  // one fact.
  const droppable = (intent: ScriptLine["intent"]) => intent === "escalate";

  while (total > budgetSec) {
    let victim = -1;
    let best = -1;
    for (let i = 1; i < kept.length; i++) {
      if (!droppable(kept[i].intent)) continue;
      // Prefer the middle: distance from the centre, inverted.
      const centrality = kept.length / 2 - Math.abs(i - kept.length / 2);
      if (centrality > best) {
        best = centrality;
        victim = i;
      }
    }
    if (victim === -1) break;
    total -= cost(kept[victim]);
    kept.splice(victim, 1);
  }

  return kept;
}

/**
 * Speaks the script and returns the track with absolute word timings.
 *
 * `id` scopes the intermediate per-line files, which are deleted once the
 * joined track exists.
 */
export async function speak(
  id: string,
  lines: ScriptLine[],
  opts: { voice?: string; rate?: string } = {},
): Promise<Narration> {
  const usable = lines.filter((l) => l.text.trim().length > 0);
  if (usable.length === 0) throw new Error("The script has no spoken lines.");

  ensureDirs();
  const pieceFiles = usable.map((_, i) => path.join(voiceDir, `${id}-l${i}.mp3`));
  const jobFile = path.join(voiceDir, `${id}-job.json`);

  // The script goes in a file rather than argv: a narration line can contain
  // quotes, apostrophes and non-ASCII, and Windows argv escaping mangles all
  // three. Same reasoning as the Remotion props file.
  fs.writeFileSync(
    jobFile,
    JSON.stringify({
      voice: opts.voice ?? env.ttsVoice,
      rate: opts.rate ?? env.ttsRate,
      lines: usable.map((l) => ({ text: l.text })),
      files: pieceFiles,
    }),
    "utf8",
  );

  let spoken: { lines: { index: number; words: { text: string; startMs: number; endMs: number }[] }[] };
  try {
    const { bin, prefix } = splitCmd(env.python);
    const { stdout } = await run(
      bin,
      [...prefix, path.resolve("src/lib/tts.py"), jobFile],
      { timeoutMs: 5 * 60_000 },
    );
    spoken = JSON.parse(stdout);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Narration failed. edge-tts must be installed: python -m pip install edge-tts\n${detail}`,
    );
  } finally {
    try {
      fs.unlinkSync(jobFile);
    } catch {
      // A leftover job file is harmless.
    }
  }

  // Measure the rendered audio rather than trusting the last word's end time:
  // edge-tts leaves a little room after the final syllable, and cutting the
  // track to the word timing clips it.
  const pieceDurations: number[] = [];
  for (const file of pieceFiles) {
    if (!fs.existsSync(file)) throw new Error(`Narration piece missing: ${file}`);
    pieceDurations.push((await probe(file)).durationSec * 1000);
  }

  // Lay the pieces out on one timeline, with the lead silence in front of each.
  const words: VoiceWord[] = [];
  const outLines: VoiceLine[] = [];
  const leads: number[] = [];
  let cursor = 0;

  usable.forEach((line, i) => {
    const lead = leadSilence(line.intent, id, i);
    leads.push(lead);
    cursor += lead;
    const start = cursor;
    const emphasis = line.intent === "payoff";

    for (const w of spoken.lines[i]?.words ?? []) {
      words.push({
        text: w.text,
        startMs: start + w.startMs,
        endMs: start + w.endMs,
        line: i,
        emphasis,
      });
    }

    cursor += pieceDurations[i];
    outLines.push({ index: i, text: line.text, intent: line.intent, startMs: start, endMs: cursor });
  });

  const durationMs = cursor + TAIL_MS;
  const audioPath = path.join(voiceDir, `${id}.mp3`);
  await joinPieces(pieceFiles, leads, audioPath);

  for (const file of pieceFiles) {
    try {
      fs.unlinkSync(file);
    } catch {
      // Leftovers here are harmless.
    }
  }

  return { audioPath, words, lines: outLines, durationMs };
}

/**
 * Concatenates the per-line audio with its lead silence into one track.
 *
 * Everything is resampled to a common rate first, because concat refuses
 * inputs whose parameters differ and anullsrc is not guaranteed to match what
 * the service returned.
 */
async function joinPieces(
  pieces: string[],
  leads: number[],
  output: string,
): Promise<void> {
  const args: string[] = ["-y", "-v", "error"];
  const parts: string[] = [];

  pieces.forEach((file, i) => {
    args.push(...silenceArgs(leads[i]));
    args.push("-i", file);
  });
  // Silence and speech alternate, so input 2i is the gap before speech 2i+1.
  pieces.forEach((_, i) => {
    parts.push(`[${i * 2}:a]`, `[${i * 2 + 1}:a]`);
  });

  const filter =
    `${parts.join("")}concat=n=${pieces.length * 2}:v=0:a=1[joined];` +
    `[joined]apad=pad_dur=${(TAIL_MS / 1000).toFixed(3)},aresample=44100[out]`;

  const { bin, prefix } = splitCmd(env.ffmpeg);
  await run(
    bin,
    [...prefix, ...args, "-filter_complex", filter, "-map", "[out]", "-c:a", "libmp3lame", "-q:a", "3", output],
    { timeoutMs: 5 * 60_000 },
  );
}
