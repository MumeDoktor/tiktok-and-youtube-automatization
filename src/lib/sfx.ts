import fs from "node:fs";
import path from "node:path";

import { ensureDirs, sfxDir } from "./media";

/**
 * The sound-effects library.
 *
 * Every file ships with the repo under media/sfx, all CC0 (see
 * media/sfx/LICENSE.md), so a render never has to reach for unverified audio.
 * The picker maps the edit's own vocabulary - transitions and Effect names -
 * onto files, which means sound arrives on every cut and every effect hit
 * without the script model having to know anything about audio.
 *
 * An empty folder degrades silently: narration alone is still a video.
 */

export type SfxKind =
  /** Short air movement, under whip transitions. */
  | "whoosh"
  /** Bigger low rush, under zoomBlur / flash transitions and cold opens. */
  | "whooshBig"
  /** Percussive transient, under shake / punch hits. */
  | "impact"
  /** Detonation tail, under flash / burn / shockwave hits. */
  | "boom"
  /** Sustained low bed, under rumble hits. */
  | "rumble"
  /** Jet-wash style roar, engine and launch moments. */
  | "roar"
  /** Broken signal, under glitch hits. */
  | "static";

const EXT = new Set([".wav", ".ogg", ".flac", ".mp3"]);

function listFiles(kind: SfxKind): string[] {
  ensureDirs();
  let names: string[];
  try {
    names = fs.readdirSync(sfxDir);
  } catch {
    return [];
  }
  return names.filter(
    (n) => n.toLowerCase().startsWith(`${kind}_`) && EXT.has(path.extname(n).toLowerCase()),
  );
}

/**
 * Deterministic pick for one kind.
 *
 * The seed is usually the clip id: re-rendering the same clip keeps its
 * sounds, two clips never share the same take of everything.
 */
export function pickSfx(kind: SfxKind, seed: string): string | null {
  const files = listFiles(kind);
  if (files.length === 0) return null;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return path.join(sfxDir, files[h % files.length]);
}

/** The sound behind one transition type. Null for cuts and quiet dissolves. */
export const TRANSITION_SFX: Partial<Record<string, SfxKind>> = {
  whipL: "whoosh",
  whipR: "whoosh",
  zoomBlur: "whooshBig",
  flash: "whooshBig",
};

/** The sound behind an effect hit's effect name. */
export const EFFECT_SFX: Record<string, SfxKind> = {
  shake: "impact",
  flash: "boom",
  shockwave: "boom",
  punch: "impact",
  rumble: "rumble",
  burn: "boom",
  glitch: "static",
  drop: "impact",
};
