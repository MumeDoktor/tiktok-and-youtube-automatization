/**
 * The per-clip layer manifest.
 *
 * The agent writes one of these for every video. It exists because a fixed
 * template is exactly what makes generated video look generated: the same
 * chrome, the same motion and the same caption treatment on every clip reads
 * as a machine even when each individual choice is defensible. An editor picks
 * the treatment for the story in front of them, so the agent does too.
 *
 * Mirrored in remotion/src/types.ts - the Remotion workspace has its own React
 * and cannot import from here.
 */

export type CaptionStyle = "kinetic" | "block" | "none";

/**
 * A visual effect fired on one spoken word.
 *
 * These exist because animation applied to the letters is decoration - it
 * happens on every word regardless of what the word means, so it stops
 * carrying information almost immediately. An effect tied to the meaning of a
 * specific word is the opposite: it fires rarely, and when it fires it is
 * because something in the story earned it.
 *
 * The pipeline already knows exactly when every word is spoken, so the only
 * thing standing between a script and this was somewhere to put the decision.
 */
export type Effect =
  /** Camera shake, decaying. Impacts, hits, collisions. */
  | "shake"
  /** A frame of white. Detonations, gunfire, ignition. */
  | "flash"
  /** An expanding ring. Blasts, pressure waves, sonic booms. */
  | "shockwave"
  /** A hard zoom that settles. Revelations and single decisive words. */
  | "punch"
  /** Sustained low-frequency tremor. Engines, dread, something approaching. */
  | "rumble"
  /** Warm light bleeding in from the edge. Fire, heat, burning. */
  | "burn"
  /** Channel split and slice. Malfunction, radiation, something going wrong. */
  | "glitch"
  /** The frame drops and recovers. Sinking, falling, loss. */
  | "drop";

/**
 * One effect, tied to a word rather than to a time.
 *
 * The agent writes the script before the narration is spoken, so it cannot
 * know when a word lands. It names the word instead and the timestamp is
 * resolved afterwards from the narrator's own timings.
 */
export type EffectHit = {
  /** Index of the narration line the word appears in. */
  line: number;
  /** The word to fire on, matched without case or punctuation. */
  word: string;
  effect: Effect;
  /** 0.3 quiet, 1 full force. */
  intensity: number;
};

/** An effect hit once its moment is known. */
export type TimedHit = { atMs: number; effect: Effect; intensity: number };
export type Grade = "archive" | "cold" | "warm" | "none";
export type Chrome = "grain" | "scanlines" | "timecode" | "stamp";
export type Move = "push" | "pull" | "driftL" | "driftR" | "hold" | "punch";

/**
 * How one shot becomes the next.
 *
 * A single transition used everywhere is what makes an edit read as generated,
 * whichever one it is - the old pipeline cross-faded every beat, and cutting
 * hard on all of them instead is the same monotony with a different texture.
 * These are chosen per cut.
 */
export type Transition =
  /** No overlap. Still the right answer for most cuts in a fast passage. */
  | "cut"
  /** Straight cross-fade. The neutral smooth option. */
  | "dissolve"
  /** Cross-fade with the incoming shot settling back from a slight push. */
  | "glide"
  /** Fast horizontal swipe with motion blur, as if the camera whipped across. */
  | "whipL"
  | "whipR"
  /** Incoming shot rushes in from oversize and resolves. Good on impacts. */
  | "zoomBlur"
  /** A frame of light through the gate. Suits archive film. */
  | "flash"
  /** Dips through black. Use it where the story takes a breath. */
  | "dipToBlack";


export type Stamp = { atSec: number; text: string };

/**
 * The ambient motion-graphics layer.
 *
 * These are the continuously-running cues - light leaks, vignette, lower
 * thirds, speed ramps - that separate "footage with captions" from graded,
 * produced video. The agent chooses per clip like every other Look field;
 * absent means on, because an archive look wants them by default.
 */
export type Motion = {
  lightLeak: boolean;
  vignette: boolean;
  /** Names the film. Text comes from the source metadata, never invented. */
  lowerThird?: { text: string; sub?: string; atSec: number; holdSec: number };
  /** Lingers through the middle of violent (punch-move) shots. */
  speedRamp: boolean;
};

export type Look = {
  captions: CaptionStyle;
  /** Seconds the hook holds before it leaves. It must leave. */
  hookExit: number;
  /** Hex accent for emphasised words and chrome. */
  accent: string;
  grade: Grade;
  chrome: Chrome[];
  stamps?: Stamp[];
  motion?: Motion;
};

export const DEFAULT_LOOK: Look = {
  captions: "kinetic",
  hookExit: 2.2,
  accent: "#E0A526",
  grade: "archive",
  chrome: ["grain"],
  stamps: [],
};

const CAPTIONS: CaptionStyle[] = ["kinetic", "block", "none"];
const GRADES: Grade[] = ["archive", "cold", "warm", "none"];
const CHROME: Chrome[] = ["grain", "scanlines", "timecode", "stamp"];

/**
 * Clamps whatever the model produced into something the composition can
 * render. A bad hex or an invented chrome name should soften the look, never
 * fail the render after the footage has already been paid for.
 */
export function normaliseLook(raw: unknown): Look {
  const r = (raw ?? {}) as Partial<Look>;
  const accent =
    typeof r.accent === "string" && /^#[0-9a-fA-F]{6}$/.test(r.accent)
      ? r.accent
      : DEFAULT_LOOK.accent;

  return {
    captions: CAPTIONS.includes(r.captions as CaptionStyle)
      ? (r.captions as CaptionStyle)
      : DEFAULT_LOOK.captions,
    // A hook that never leaves is the single loudest template tell, so the
    // ceiling here is deliberate and low.
    hookExit: Math.min(4, Math.max(0.8, Number(r.hookExit) || DEFAULT_LOOK.hookExit)),
    accent,
    grade: GRADES.includes(r.grade as Grade) ? (r.grade as Grade) : DEFAULT_LOOK.grade,
    chrome: Array.isArray(r.chrome)
      ? [...new Set(r.chrome.filter((c): c is Chrome => CHROME.includes(c as Chrome)))]
      : DEFAULT_LOOK.chrome,
    stamps: Array.isArray(r.stamps)
      ? r.stamps
          .filter((s) => s && typeof s.text === "string" && Number.isFinite(Number(s.atSec)))
          .slice(0, 6)
          .map((s) => ({ atSec: Math.max(0, Number(s.atSec)), text: s.text.slice(0, 48) }))
      : [],
    motion: normaliseMotion(r.motion),
  };
}

/** Softens a bad motion manifest rather than failing the render. */
function normaliseMotion(raw: unknown): Motion {
  const m = (raw ?? {}) as Partial<Motion>;
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  let lowerThird: Motion["lowerThird"];
  if (
    m.lowerThird &&
    typeof m.lowerThird === "object" &&
    typeof (m.lowerThird as { text?: unknown }).text === "string" &&
    Number.isFinite(Number((m.lowerThird as { atSec?: unknown }).atSec))
  ) {
    const lt = m.lowerThird as { text: string; sub?: string; atSec: number; holdSec?: number };
    lowerThird = {
      text: lt.text.slice(0, 60),
      sub: typeof lt.sub === "string" ? lt.sub.slice(0, 48) : undefined,
      atSec: Math.max(1, Number(lt.atSec)),
      holdSec: Math.min(6, Math.max(1.5, Number(lt.holdSec) || 3)),
    };
  }
  return {
    lightLeak: bool(m.lightLeak, true),
    vignette: bool(m.vignette, true),
    speedRamp: bool(m.speedRamp, true),
    ...(lowerThird ? { lowerThird } : {}),
  };
}

/**
 * Turns word-named effects into timed ones.
 *
 * Matching is loose on purpose: the writer produces "bomb." or "Bomb" while
 * the narrator reports "bomb", and an effect silently dropped over
 * punctuation would be impossible to notice in a finished video. A hit that
 * still cannot be matched is discarded rather than guessed at - firing a
 * shockwave on the wrong word is worse than firing none.
 */
export function resolveHits(
  wanted: EffectHit[],
  words: Array<{ text: string; startMs: number; line: number }>,
): TimedHit[] {
  const clean = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
  const out: TimedHit[] = [];

  for (const hit of wanted) {
    const target = clean(hit.word);
    if (!target) continue;
    // Prefer the named line, but fall back to anywhere: the trimmer can drop a
    // line after the script was written, which shifts every index after it.
    const match =
      words.find((w) => w.line === hit.line && clean(w.text) === target) ??
      words.find((w) => clean(w.text) === target);
    if (!match) continue;
    out.push({ atMs: match.startMs, effect: hit.effect, intensity: hit.intensity });
  }

  return out.sort((a, b) => a.atMs - b.atMs);
}
