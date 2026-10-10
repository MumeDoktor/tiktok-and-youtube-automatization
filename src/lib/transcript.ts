/**
 * Turning a caption track into sentences.
 *
 * The narrated path gets this structure for free: the writer produces lines,
 * the narrator times them, and everything downstream - captions, cuts, effect
 * hits - hangs off those line boundaries. A podcast has no such structure. It
 * arrives as a flat run of caption words, and until it is grouped there is
 * nothing for the edit to be built against.
 *
 * That absence is why the podcast path cut every four seconds and captioned
 * one word at a time: not a design decision, just the only thing possible
 * without sentences.
 */
import { cuesToWords, type Cue } from "./media";

export type TranscriptWord = {
  text: string;
  startMs: number;
  endMs: number;
  /** Index of the sentence this word belongs to. */
  line: number;
  emphasis: boolean;
};

export type TranscriptLine = {
  index: number;
  text: string;
  startMs: number;
  endMs: number;
};

/**
 * A pause long enough to end a sentence.
 *
 * Auto-captions frequently carry no punctuation at all, so silence is the only
 * boundary signal that is always present. Six hundred milliseconds is about
 * where a speaker's pause stops being a breath and starts being a full stop.
 */
const PAUSE_MS = 600;

/** Beyond this a caption is too long to read before it changes. */
const MAX_WORDS = 12;

/** Below this a sentence is a fragment, and is merged backwards instead. */
const MIN_WORDS = 3;

/** True when a word's punctuation ends a sentence. */
function terminal(text: string): boolean {
  return /[.!?]["')\]]?$/.test(text.trim());
}

/**
 * Groups a segment's caption words into sentences.
 *
 * Times come back relative to `startSec`, matching cuesToWords, because the
 * clip is cut from there and the composition knows nothing about where the
 * segment sat in the source.
 */
export function toSentences(
  cues: Cue[],
  startSec: number,
  endSec: number,
): { words: TranscriptWord[]; lines: TranscriptLine[] } {
  const flat = cuesToWords(cues, startSec, endSec);
  if (flat.length === 0) return { words: [], lines: [] };

  // 1. Cut the run into groups on punctuation, silence, or length.
  const groups: Array<typeof flat> = [];
  let current: typeof flat = [];

  for (let i = 0; i < flat.length; i++) {
    const word = flat[i];
    const previous = flat[i - 1];

    const gap = previous ? word.startMs - previous.endMs : 0;
    const breakBefore =
      current.length > 0 &&
      (gap >= PAUSE_MS || (previous && terminal(previous.text)) || current.length >= MAX_WORDS);

    if (breakBefore) {
      groups.push(current);
      current = [];
    }
    current.push(word);
  }
  if (current.length > 0) groups.push(current);

  // 2. Fold fragments into their neighbour. A three-word caption on screen for
  // half a second reads as a flicker, and a cut made on it lands on nothing.
  const merged: Array<typeof flat> = [];
  for (const group of groups) {
    const last = merged[merged.length - 1];
    if (group.length < MIN_WORDS && last && last.length + group.length <= MAX_WORDS + MIN_WORDS) {
      last.push(...group);
    } else {
      merged.push(group);
    }
  }

  // 3. Number them. The line index is what Captions groups by and what an
  // effect hit names, so it has to be the sentence, never the word.
  const words: TranscriptWord[] = [];
  const lines: TranscriptLine[] = [];

  merged.forEach((group, index) => {
    for (const w of group) {
      words.push({ text: w.text, startMs: w.startMs, endMs: w.endMs, line: index, emphasis: false });
    }
    lines.push({
      index,
      text: group.map((w) => w.text).join(" "),
      startMs: group[0].startMs,
      endMs: group[group.length - 1].endMs,
    });
  });

  return { words, lines };
}

/**
 * Renders sentences for a prompt, numbered so the model can refer to one.
 *
 * The index it sees is the index an effect hit has to name, so the two must
 * not drift apart.
 */
export function renderSentences(lines: TranscriptLine[]): string {
  return lines
    .map((l) => `[line ${l.index}] ${(l.startMs / 1000).toFixed(1)}s - ${l.text}`)
    .join("\n");
}
