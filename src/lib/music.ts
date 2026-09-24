import fs from "node:fs";
import path from "node:path";

import { ensureDirs, musicDir } from "./media";

/**
 * The music bed.
 *
 * Tracks are supplied by hand, never fetched. The account's own rule is
 * "never use audio or footage with unverified rights", and a folder the owner
 * filled themselves is the only arrangement where that stays true without a
 * licensing check on every render.
 *
 * An empty folder is normal, not an error - the video is narrated, so it has
 * audio either way.
 */

const AUDIO = new Set([".mp3", ".m4a", ".aac", ".wav", ".ogg", ".flac"]);

export type Track = { path: string; name: string; moods: string[] };

/**
 * Lists the available beds.
 *
 * Mood comes from the filename: anything before the first dash, split on
 * underscores. `tense_cold-drums.mp3` is tense and cold. It is a convention
 * rather than a manifest because the owner drops files in by hand, and a
 * sidecar JSON they have to remember to edit would go stale immediately.
 */
export function listTracks(): Track[] {
  ensureDirs();
  let names: string[];
  try {
    names = fs.readdirSync(musicDir);
  } catch {
    return [];
  }

  return names
    .filter((n) => AUDIO.has(path.extname(n).toLowerCase()))
    .map((n) => {
      const base = path.basename(n, path.extname(n));
      const head = base.split("-")[0];
      return {
        path: path.join(musicDir, n),
        name: base,
        moods: head
          .split(/[_\s]+/)
          .map((m) => m.trim().toLowerCase())
          .filter(Boolean),
      };
    });
}

/**
 * Picks the bed whose mood tags best match what the writer asked for.
 *
 * Falls back to any track rather than none: a bed that is merely adequate
 * still beats a narration sitting on silence.
 */
export function pickTrack(mood: string): Track | null {
  const tracks = listTracks();
  if (tracks.length === 0) return null;

  const wanted = mood
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);

  if (wanted.length === 0) return tracks[0];

  let best: Track | null = null;
  let bestScore = 0;
  for (const track of tracks) {
    const score = track.moods.filter((m) => wanted.some((w) => m.includes(w) || w.includes(m))).length;
    if (score > bestScore) {
      best = track;
      bestScore = score;
    }
  }

  return best ?? tracks[0];
}
