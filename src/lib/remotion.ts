import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { Look, Move, TimedHit, Transition } from "./look";
import { outDir } from "./media";

/**
 * Renders finished clips with Remotion.
 *
 * Remotion lives in its own workspace at ./remotion with its own React 18,
 * because this app runs React 19 and the two cannot share a tree. The bridge
 * is the CLI: props go in as a JSON file, an mp4 comes out.
 */

export const remotionDir = path.resolve(process.cwd(), "remotion");

export type RenderShot = {
  /** Local file to stage into remotion/public. */
  path: string;
  /** Where this shot sits in the finished video. */
  startMs: number;
  endMs: number;
  move: Move;
  /** How this shot arrives over the one before it. */
  transition: Transition;
  transitionMs: number;
};

export type RenderWord = {
  text: string;
  startMs: number;
  endMs: number;
  line: number;
  emphasis: boolean;
};

export type RenderLine = { index: number; text: string; startMs: number; endMs: number };

export type RenderOptions = {
  shots: RenderShot[];
  words: RenderWord[];
  lines: RenderLine[];
  hookText: string;
  /** Narration track. Without it the video is silent, which is fatal on TikTok. */
  voicePath?: string;
  /** Licensed bed, ducked under the narration. */
  musicPath?: string;
  musicVolume?: number;
  /** Total length, taken from the narration. */
  durationMs: number;
  /** Effects fired on words, already resolved to timestamps. */
  hits?: TimedHit[];
  /** Sound effects to place, as local files. Staged like any other asset. */
  sfx?: Array<{ path: string; atMs: number; gain: number }>;
  look: Look;
  /** Render 1920x1080 instead of the vertical frame (long-form YouTube). */
  wide?: boolean;
};

function run(args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", args, {
      cwd,
      // npx resolves through the shell on Windows.
      shell: true,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Remotion render timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not start Remotion: ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout);
      const tail = (stderr || stdout).trim().split("\n").slice(-12).join("\n");
      reject(new Error(`Remotion exited ${code}:\n${tail}`));
    });
  });
}

export function remotionAvailable(): boolean {
  return fs.existsSync(path.join(remotionDir, "node_modules", "remotion"));
}

/**
 * Stages a file into remotion/public and returns the name to reference it by.
 *
 * Remotion serves local media only from its public folder. A hard link avoids
 * copying tens of megabytes; it only works on the same volume, so fall back to
 * a copy.
 */
function stage(publicDir: string, source: string, name: string): string {
  const staged = path.join(publicDir, name);
  if (fs.existsSync(staged)) fs.unlinkSync(staged);
  try {
    fs.linkSync(path.resolve(source), staged);
  } catch {
    fs.copyFileSync(path.resolve(source), staged);
  }
  return staged;
}

/**
 * Renders one clip and returns the finished mp4 path.
 *
 * Props are written to a temp file rather than passed inline: a caption can
 * contain quotes, newlines and apostrophes, and Windows command-line escaping
 * mangles all three.
 */
export async function renderClip(id: string, opts: RenderOptions): Promise<string> {
  if (!remotionAvailable()) {
    throw new Error(
      'Remotion is not installed. Run "npm install" inside the remotion/ directory.',
    );
  }
  if (opts.shots.length === 0) {
    throw new Error("No footage given to render.");
  }
  for (const shot of opts.shots) {
    if (!fs.existsSync(shot.path)) throw new Error(`Source video is missing: ${shot.path}`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const output = path.join(outDir, `${id}.mp4`);

  const publicDir = path.join(remotionDir, "public");
  fs.mkdirSync(publicDir, { recursive: true });
  const stagedPaths: string[] = [];

  const shots = opts.shots.map((shot, i) => {
    const name = `${id}-${i}${path.extname(shot.path) || ".mp4"}`;
    stagedPaths.push(stage(publicDir, shot.path, name));
    return {
      file: name,
      startMs: shot.startMs,
      endMs: shot.endMs,
      move: shot.move,
      transition: shot.transition,
      transitionMs: shot.transitionMs,
    };
  });

  let voiceFile: string | undefined;
  if (opts.voicePath && fs.existsSync(opts.voicePath)) {
    voiceFile = `${id}-voice${path.extname(opts.voicePath) || ".mp3"}`;
    stagedPaths.push(stage(publicDir, opts.voicePath, voiceFile));
  }

  let musicFile: string | undefined;
  if (opts.musicPath && fs.existsSync(opts.musicPath)) {
    musicFile = `${id}-music${path.extname(opts.musicPath) || ".mp3"}`;
    stagedPaths.push(stage(publicDir, opts.musicPath, musicFile));
  }

  // Several effects usually reuse the same handful of source files, so each
  // distinct file is staged once and referenced by however many hits need it.
  const sfxNames = new Map<string, string>();
  const sfx = (opts.sfx ?? [])
    .filter((s) => fs.existsSync(s.path))
    .map((s, i) => {
      let name = sfxNames.get(s.path);
      if (!name) {
        name = `${id}-sfx${sfxNames.size}${path.extname(s.path) || ".wav"}`;
        stagedPaths.push(stage(publicDir, s.path, name));
        sfxNames.set(s.path, name);
      }
      void i;
      return { file: name, atMs: s.atMs, gain: s.gain };
    });

  const props = {
    shots,
    words: opts.words,
    lines: opts.lines,
    hookText: opts.hookText,
    voiceFile,
    musicFile,
    // Low by default: the narration has to stay intelligible, and a bed that
    // competes with it loses the viewer faster than no bed at all.
    musicVolume: opts.musicVolume ?? 0.16,
    durationMs: opts.durationMs,
    hits: opts.hits ?? [],
    sfx,
    look: opts.look,
  };

  const propsFile = path.join(remotionDir, `.props-${id}.json`);
  fs.writeFileSync(propsFile, JSON.stringify(props), "utf8");

  try {
    await run(
      [
        "remotion",
        "render",
        "src/index.ts",
        opts.wide ? "ClipWide" : "Clip",
        output,
        `--props=${propsFile}`,
        // Without an explicit codec the audio track is dropped on some
        // platforms, which is exactly the failure this rewrite exists to fix.
        "--audio-codec=aac",
        "--log=error",
      ],
      remotionDir,
      // A shot list is many more source files than the old three beats, so
      // this needs more room than the previous fifteen minutes.
      25 * 60_000,
    );
  } finally {
    // Neither temp file is worth keeping, and a staged asset is a full copy of
    // the source when hard-linking was not possible.
    for (const temp of [propsFile, ...stagedPaths]) {
      try {
        fs.unlinkSync(temp);
      } catch {
        // Leftovers here are harmless.
      }
    }
  }

  if (!fs.existsSync(output) || fs.statSync(output).size < 10_000) {
    throw new Error("Remotion finished but produced no usable file.");
  }
  return output;
}

/** One scene of a sourced story. Mirrors remotion/src/Story.tsx. */
export type StoryPlace = { name: string; lat: number; lon: number };
export type StoryScene = {
  startMs: number;
  endMs: number;
  kind: "title" | "photo" | "map" | "quote" | "number" | "fact";
  /** A local picture: the photograph itself, or the dimmed backdrop of a card. */
  path?: string;
  caption?: string;
  credit?: string;
  text?: string;
  sub?: string;
  source?: string;
  from?: StoryPlace;
  to?: StoryPlace;
  point?: StoryPlace;
  progress?: number;
};

/**
 * Renders photographs, maps and cards timed to a narration, in 1920x1080.
 *
 * The same staging as renderClip: pictures are linked into remotion/public for
 * the length of the render and removed afterwards.
 */
export async function renderStory(
  id: string,
  opts: { scenes: StoryScene[]; voicePath?: string; durationMs: number; accent?: string },
): Promise<string> {
  if (!remotionAvailable()) {
    throw new Error('Remotion is not installed. Run "npm install" inside the remotion/ directory.');
  }
  if (opts.scenes.length === 0) throw new Error("No scenes given to render.");

  fs.mkdirSync(outDir, { recursive: true });
  const output = path.join(outDir, `${id}.mp4`);
  const publicDir = path.join(remotionDir, "public");
  fs.mkdirSync(publicDir, { recursive: true });
  const stagedPaths: string[] = [];

  // A photograph is usually shown more than once; each file is staged once.
  const names = new Map<string, string>();
  const scenes = opts.scenes.map(({ path: file, ...scene }) => {
    if (!file || !fs.existsSync(file)) return scene;
    let name = names.get(file);
    if (!name) {
      name = `${id}-p${names.size}${path.extname(file) || ".jpg"}`;
      stagedPaths.push(stage(publicDir, file, name));
      names.set(file, name);
    }
    return { ...scene, file: name };
  });

  let voiceFile: string | undefined;
  if (opts.voicePath && fs.existsSync(opts.voicePath)) {
    voiceFile = `${id}-voice${path.extname(opts.voicePath) || ".mp3"}`;
    stagedPaths.push(stage(publicDir, opts.voicePath, voiceFile));
  }

  const propsFile = path.join(remotionDir, `.props-${id}.json`);
  fs.writeFileSync(
    propsFile,
    JSON.stringify({ scenes, voiceFile, durationMs: opts.durationMs, accent: opts.accent ?? "#E0A526" }),
    "utf8",
  );

  try {
    await run(
      ["remotion", "render", "src/index.ts", "Story", output, `--props=${propsFile}`, "--audio-codec=aac", "--log=error"],
      remotionDir,
      40 * 60_000,
    );
  } finally {
    for (const temp of [propsFile, ...stagedPaths]) {
      try {
        fs.unlinkSync(temp);
      } catch {
        // Leftovers here are harmless.
      }
    }
  }

  if (!fs.existsSync(output) || fs.statSync(output).size < 10_000) {
    throw new Error("Remotion finished but produced no usable file.");
  }
  return output;
}
