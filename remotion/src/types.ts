/**
 * Mirrors src/lib/look.ts in the Next app.
 *
 * This workspace has its own React 18 and cannot import across, so the shape
 * is duplicated on purpose. Keep the two in step.
 */

export type CaptionStyle = "kinetic" | "block" | "none";
export type Grade = "archive" | "cold" | "warm" | "none";
export type Chrome = "grain" | "scanlines" | "timecode" | "stamp";
export type Move = "push" | "pull" | "driftL" | "driftR" | "hold" | "punch";
export type Transition =
  | "cut"
  | "dissolve"
  | "glide"
  | "whipL"
  | "whipR"
  | "zoomBlur"
  | "flash"
  | "dipToBlack";

export type Stamp = { atSec: number; text: string };

/** Mirrors src/lib/look.ts. */
export type Effect =
  | "shake"
  | "flash"
  | "shockwave"
  | "punch"
  | "rumble"
  | "burn"
  | "glitch"
  | "drop";

/** An effect once its moment in the finished video is known. */
export type TimedHit = { atMs: number; effect: Effect; intensity: number };

export type Look = {
  captions: CaptionStyle;
  hookExit: number;
  accent: string;
  grade: Grade;
  chrome: Chrome[];
  stamps?: Stamp[];
  /** Ambient motion-graphics layer. Absent = all defaults on for archive looks. */
  motion?: Motion;
};

export type Motion = {
  lightLeak: boolean;
  vignette: boolean;
  /** Lower-third card naming the film; text comes from the edit, not the model. */
  lowerThird?: { text: string; sub?: string; atSec: number; holdSec: number };
  /** Speed-ramp the most violent shot (linger through its middle). */
  speedRamp: boolean;
};


/** One cut. Timings are absolute positions in the finished video. */
export type Shot = {
  /** File name inside remotion/public. */
  file: string;
  startMs: number;
  endMs: number;
  move: Move;
  /** How this shot arrives over the one before it. */
  transition: Transition;
  /** Length of that transition in ms. Zero for a hard cut. */
  transitionMs: number;
};

export type Word = {
  text: string;
  startMs: number;
  endMs: number;
  line: number;
  /** Set on the payoff line, so the composition can hit it harder. */
  emphasis: boolean;
};

export type Line = {
  index: number;
  text: string;
  startMs: number;
  endMs: number;
};

/**
 * One sound effect, already placed in the finished video.
 *
 * Mounted as its own audio layer rather than mixed into the voice track,
 * because a clip built from an interview has no separate voice track to mix
 * into - the speech is inside the shot footage itself.
 */
export type Sfx = {
  /** File name inside remotion/public. */
  file: string;
  atMs: number;
  gain: number;
};

export type ClipProps = {
  shots: Shot[];
  words: Word[];
  lines: Line[];
  /** Burned across the upper third, then it leaves. */
  hookText: string;
  /** Narration track in remotion/public. */
  voiceFile?: string;
  /** Licensed bed in remotion/public. */
  musicFile?: string;
  musicVolume: number;
  /** Total length. Comes from the narration, not from summing shots. */
  durationMs: number;
  /**
   * Effects fired on individual spoken words. Resolved to timestamps from the
   * narrator's own word timings before the render starts.
   */
  hits: TimedHit[];
  /** Sound effects on cuts and effect hits. */
  sfx?: Sfx[];
  look: Look;
};
