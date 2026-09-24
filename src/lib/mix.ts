import fs from "node:fs";
import path from "node:path";

import { env } from "./env";
import { ensureDirs, outDir, probe, run, splitCmd } from "./media";
import { pickSfx, TRANSITION_SFX, EFFECT_SFX, type SfxKind } from "./sfx";

/**
 * The sound stage.
 *
 * The old mix was two layers - narration over a flat-volume bed - which is
 * why finished clips sounded like a slideshow with commentary. This builds the
 * full soundtrack before the render: sound effects land on the cuts and on
 * the effect hits the writer chose, and the music is ducked under the voice
 * with a real sidechain rather than a fixed multiplier.
 *
 * Mixing happens here rather than inside Remotion because ffmpeg's
 * sidechaincompress does properly what a component-level volume ramp can only
 * fake, and because it keeps the composition's audio graph down to one track.
 */

export type MixEvent = {
  /** Absolute position in the finished video. */
  atMs: number;
  kind: SfxKind;
  /** 0..1.5ish, scaled against the event's own meaning. */
  gain: number;
};

export type MixInput = {
  narrationPath: string;
  /** Licensed bed. Optional - narrated silence still works. */
  musicPath?: string | null;
  /** Seed keeps the deterministic SFX picks stable across re-renders. */
  seed: string;
};

/** Where the mixed track lands until the render consumes it. */
function mixDir(): string {
  return outDir;
}
/**
 * Builds the SFX timeline from the edit itself.
 *
 * Every transition that moves air gets air; every effect hit gets the sound
 * its name promises. Gains sit low - these are punctuation, not the subject.
 */
export function planSoundDesign(
  shots: Array<{ transition: string; startMs: number }>,
  hits: Array<{ atMs: number; effect: string; intensity: number }>,
  seed: string,
): Array<{ atMs: number; kind: SfxKind; gain: number; file: string }> {
  const out: Array<{ atMs: number; kind: SfxKind; gain: number; file: string }> = [];

  // Skip the first shot: it arrives over nothing, so a whoosh would fire into
  // silence at t=0 and step on the hook.
  for (let i = 1; i < shots.length; i++) {
    const kind = TRANSITION_SFX[shots[i].transition];
    if (!kind) continue;
    const file = pickSfx(kind, `${seed}:t${i}`);
    if (!file) continue;
    out.push({ atMs: Math.max(0, shots[i].startMs - 60), kind, gain: 0.5, file });
  }

  for (const hit of hits) {
    const kind = EFFECT_SFX[hit.effect];
    if (!kind) continue;
    const file = pickSfx(kind, `${seed}:h${hit.atMs}`);
    if (!file) continue;
    // The writer's intensity carries through: a suggested hit is quieter than
    // a full-force one.
    out.push({ atMs: hit.atMs, kind, gain: 0.45 + 0.45 * clamp(hit.intensity), file });
  }

  return out.sort((a, b) => a.atMs - b.atMs);
}

/**
 * Renders the complete soundtrack: narration, ducked music, sound effects.
 *
 * Returns the narration path unchanged when there is nothing to add - a mix
 * of one input is a copy, and copying wastes seconds on every render.
 */
export async function buildSoundtrack(
  id: string,
  input: MixInput,
  events: Array<{ atMs: number; gain: number; file: string }>,
): Promise<string> {
  const hasMusic = Boolean(input.musicPath && fs.existsSync(input.musicPath));
  const usable = events.filter((e) => fs.existsSync(e.file));
  if (!hasMusic && usable.length === 0) return input.narrationPath;

  ensureDirs();
  const output = path.join(mixDir(), `${id}-mix.m4a`);

  const args: string[] = ["-y", "-v", "error"];
  const filters: string[] = [];
  let idx = 0;

  // [0] narration
  args.push("-i", input.narrationPath);
  const voiceIdx = idx++;

  let musicIdx: number | null = null;
  if (hasMusic) {
    args.push("-i", input.musicPath!);
    musicIdx = idx++;
  }

  // Each effect: place it in time, scale it, and give the tail room to ring.
  const placed: number[] = [];
  for (const e of usable) {
    args.push("-i", e.file);
    const i = idx++;
    filters.push(
      `[${i}:a]aresample=44100,aformat=channel_layouts=stereo,` +
        `adelay=${Math.round(e.atMs)}|${Math.round(e.atMs)},volume=${e.gain.toFixed(2)}[e${i}]`,
    );
    placed.push(i);
  }

  // Duck the music under the voice with a real sidechain: the bed breathes
  // back up in the pauses between sentences, which a static volume never does.
  // Without a bed the voice label is just the input itself.
  let voiceLabel: string;
  if (musicIdx !== null) {
    filters.push(
      `[${voiceIdx}:a]asplit=2[voiceKey][voiceMain]`,
      `[${musicIdx}:a]aresample=44100,aformat=channel_layouts=stereo,volume=0.55[bedRaw]`,
      `[bedRaw][voiceKey]sidechaincompress=threshold=0.02:ratio=6:attack=20:release=400:makeup=1[bed]`,
    );
    voiceLabel = "[voiceMain]";
  } else {
    // amix wants every input as a labelled pad, so bracket even a raw
    // stream specifier.
    filters.push(`[${voiceIdx}:a]anull[voiceMain]`);
    voiceLabel = "[voiceMain]";
  }

  // Sum everything. normalize=0 keeps the narration at unity; the sources are
  // quiet enough by construction that clipping is not a risk.
  const parts = [voiceLabel, ...placed.map((i) => `[e${i}]`)];
  const n = parts.length;
  filters.push(
    `${parts.join("")}amix=inputs=${n}:normalize=0:dropout_transition=0[mix]`,
  );
  filters.push(`[mix]alimiter=limit=0.95,aresample=44100[out]`);

  const { bin, prefix } = splitCmd(env.ffmpeg);
  await run(
    bin,
    [...prefix, ...args, "-filter_complex", filters.join(";"), "-map", "[out]", "-c:a", "aac", "-b:a", "192k", output],
    { timeoutMs: 3 * 60_000 },
  );

  const done = await probe(output);
  if (done.durationSec < 1) throw new Error("Mixed soundtrack came back empty.");
  return output;
}

function clamp(v: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0.6));
}
