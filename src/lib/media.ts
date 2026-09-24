import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { env } from "./env";

/* ------------------------------------------------------------------ */
/* Process helper                                                      */
/* ------------------------------------------------------------------ */

export type RunResult = { stdout: string; stderr: string };

export function run(
  command: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      windowsHide: true,
      // No shell: arguments stay separate, so a caption or URL containing
      // quotes or semicolons can never turn into another command.
      shell: false,
      env: {
        ...process.env,
        // Writing to a pipe on Windows, Python defaults to the console
        // codepage, which mangles every non-ASCII character in a title -
        // curly quotes and dashes are in half the podcast titles there are.
        PYTHONIOENCODING: "utf-8",
      },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`${command} timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs)
      : null;

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`Failed to start ${command}: ${err.message}`));
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else {
        const tail = stderr.trim().split("\n").slice(-8).join("\n");
        reject(new Error(`${command} exited ${code}:\n${tail}`));
      }
    });
  });
}

/** Splits "python -m yt_dlp" into a command plus leading args. */
export function splitCmd(cmd: string): { bin: string; prefix: string[] } {
  const parts = cmd.trim().split(/\s+/);
  return { bin: parts[0], prefix: parts.slice(1) };
}

/**
 * Cookie flags for yt-dlp, or nothing when none are configured.
 *
 * YouTube serves an anonymous request happily right up until it does not, and
 * then every call in this file fails at once with a bot check. Threading these
 * through every invocation means the fix is one env var rather than an edit in
 * four places.
 */
export function ytdlpAuth(): string[] {
  if (env.ytDlpCookieFile) return ["--cookies", env.ytDlpCookieFile];
  if (env.ytDlpCookiesFromBrowser)
    return ["--cookies-from-browser", env.ytDlpCookiesFromBrowser];
  return [];
}

// Must be absolute: ffmpeg runs with cwd set to mediaDir (so filtergraphs can
// reference the font by relative path), which would otherwise re-resolve every
// relative media path against itself.
export const mediaDir = path.resolve(env.mediaDir);
export const rawDir = path.join(mediaDir, "raw");
export const outDir = path.join(mediaDir, "out");
/** Narration tracks, one per clip plus the per-line pieces they are built from. */
export const voiceDir = path.join(mediaDir, "voice");
/**
 * Music beds the owner has licensed. Nothing writes here - it is filled by
 * hand, which is what keeps the "no audio with unverified rights" rule true.
 */
export const musicDir = path.join(mediaDir, "music");
/** Bundled CC0 sound effects, keyed by family prefix (whoosh_*, hit_*...). */
export const sfxDir = path.join(mediaDir, "sfx");

export function ensureDirs() {
  for (const d of [mediaDir, rawDir, outDir, voiceDir, musicDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

/* ------------------------------------------------------------------ */
/* Probe                                                               */
/* ------------------------------------------------------------------ */

export type Probe = {
  durationSec: number;
  width: number;
  height: number;
  sizeBytes: number;
  hasAudio: boolean;
};

export async function probe(file: string): Promise<Probe> {
  const { bin, prefix } = splitCmd(env.ffprobe);
  const { stdout } = await run(
    bin,
    [
      ...prefix,
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      file,
    ],
    { timeoutMs: 60_000 },
  );

  const json = JSON.parse(stdout) as {
    format?: { duration?: string; size?: string };
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      duration?: string;
    }>;
  };

  const video = json.streams?.find((s) => s.codec_type === "video");
  // Some containers omit format duration; the stream usually still carries it.
  const duration =
    Number(json.format?.duration ?? 0) || Number(video?.duration ?? 0) || 0;

  return {
    durationSec: duration,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    sizeBytes: Number(json.format?.size ?? 0),
    hasAudio: Boolean(json.streams?.some((s) => s.codec_type === "audio")),
  };
}

/* ------------------------------------------------------------------ */
/* Download (yt-dlp)                                                   */
/* ------------------------------------------------------------------ */

export type DownloadResult = {
  path: string;
  title: string;
  sourceUrl: string;
  durationSec: number;
  uploader: string | null;
  license: string | null;
};

/**
 * Downloads one video. `target` is either a direct URL or a yt-dlp search
 * expression such as "ytsearch1:golden retriever puppy 4k".
 *
 * The caller is responsible for whether reposting the result is lawful -
 * this returns uploader and license so that decision can be recorded.
 */
export async function downloadVideo(
  target: string,
  id: string,
  opts: {
    maxHeight?: number;
    maxDurationSec?: number;
    /**
     * Fetch only this slice instead of the whole file. Archive films run to
     * twenty minutes or more, so pulling all of it to cut forty seconds is
     * the difference between a few seconds and several minutes.
     */
    section?: { startSec: number; durationSec: number };
  } = {},
): Promise<DownloadResult> {
  ensureDirs();
  const { bin, prefix } = splitCmd(env.ytDlp);
  const template = path.join(rawDir, `${id}.%(ext)s`);
  const maxHeight = opts.maxHeight ?? 1920;

  // Start every attempt from a clean slate. A retry that leaves the previous
  // attempt's video on disk cannot tell the two apart afterwards, and a failed
  // job retries three times. Captions are left alone: they were written by a
  // separate step that has already finished with them.
  for (const stale of fs.readdirSync(rawDir)) {
    if (!stale.startsWith(`${id}.`) && !stale.startsWith(`${id}-`)) continue;
    if (stale.endsWith(".vtt")) continue;
    try {
      fs.unlinkSync(path.join(rawDir, stale));
    } catch {
      // A locked leftover gets overwritten by the download that follows.
    }
  }

  const args = [
    ...prefix,
    ...ytdlpAuth(),
    "--no-playlist",
    "--no-warnings",
    "--newline",
    // Cap resolution and prefer a single already-muxed mp4 where possible.
    "-f",
    `bv*[height<=${maxHeight}]+ba/b[height<=${maxHeight}]/b`,
    "--merge-output-format",
    "mp4",
    "-o",
    template,
    "--print-json",
    "--no-simulate",
  ];

  if (opts.maxDurationSec) {
    args.push("--match-filter", `duration < ${opts.maxDurationSec}`);
  }

  const section = opts.section
    ? {
        from: Math.max(0, Math.floor(opts.section.startSec)),
        to: Math.ceil(
          Math.max(0, Math.floor(opts.section.startSec)) +
            Math.max(1, opts.section.durationSec),
        ),
      }
    : null;

  if (section) {
    args.push("--download-sections", `*${section.from}-${section.to}`);
  }

  args.push(target);

  // --force-keyframes-at-cuts makes the cut land exactly where asked, but it
  // re-encodes during download and some sources fail outright under it. Try
  // the accurate path first, then fall back to a keyframe-aligned cut, which
  // may start a second or two early but does produce a file.
  let stdout: string;
  if (section) {
    try {
      const accurate = [...args];
      accurate.splice(accurate.length - 1, 0, "--force-keyframes-at-cuts");
      ({ stdout } = await run(bin, accurate, { timeoutMs: 15 * 60_000 }));
    } catch {
      for (const stale of fs
        .readdirSync(rawDir)
        .filter((f) => f.startsWith(`${id}.`))) {
        try {
          fs.unlinkSync(path.join(rawDir, stale));
        } catch {
          // A leftover partial download is harmless; it gets overwritten.
        }
      }
      ({ stdout } = await run(bin, args, { timeoutMs: 15 * 60_000 }));
    }
  } else {
    ({ stdout } = await run(bin, args, { timeoutMs: 15 * 60_000 }));
  }

  // --print-json emits one JSON object per download; take the last complete one.
  const line = stdout
    .trim()
    .split("\n")
    .reverse()
    .find((l) => l.trim().startsWith("{"));

  if (!line) {
    throw new Error("yt-dlp produced no metadata - nothing matched the query");
  }

  const meta = JSON.parse(line) as {
    title?: string;
    webpage_url?: string;
    duration?: number;
    uploader?: string;
    license?: string;
    _filename?: string;
    ext?: string;
  };

  // yt-dlp reports the pre-merge filename; resolve what actually landed.
  //
  // Two things have to be excluded, and both only bite on a retry, when files
  // from the previous attempt are still on disk:
  //
  // - Anything already remuxed. ".fixed.mp4" sorts before ".mp4", so a plain
  //   search for an mp4 finds the PREVIOUS attempt's output, remuxes that
  //   instead of the fresh download, and leaves ".fixed.fixed.mp4" behind. A
  //   third attempt makes it ".fixed.fixed.fixed.mp4", each one a generation
  //   further from the video that was actually just fetched.
  // - Anything that is not video. The old fallback took whatever came first,
  //   which on this path is the caption track written moments earlier.
  const VIDEO_EXT = new Set([".mp4", ".mkv", ".webm", ".m4v", ".mov"]);
  const candidates = fs
    .readdirSync(rawDir)
    .filter((f) => f.startsWith(`${id}.`) && !f.includes(".fixed."))
    .filter((f) => VIDEO_EXT.has(path.extname(f).toLowerCase()))
    .map((f) => path.join(rawDir, f));

  const file =
    candidates.find((f) => f.endsWith(".mp4")) ?? candidates[0] ?? meta._filename;

  if (!file || !fs.existsSync(file)) {
    throw new Error(`Download finished but no file was found for id ${id}`);
  }

  // A section download needs its timestamps repaired before anything can cut
  // it accurately.
  const finalPath = section ? await remux(file) : file;

  return {
    path: finalPath,
    title: meta.title ?? id,
    sourceUrl: meta.webpage_url ?? target,
    durationSec: meta.duration ?? 0,
    uploader: meta.uploader ?? null,
    license: meta.license ?? null,
  };
}

/**
 * Grabs a still for the dashboard.
 *
 * Tries an output-side seek first: input-side seeking (-ss before -i) needs
 * container duration metadata, which archive-sourced files often lack, and
 * fails with an empty image2 output. Falls back to the very first frame.
 */
export async function extractThumbnail(input: string, id: string): Promise<string> {
  ensureDirs();
  const { bin, prefix } = splitCmd(env.ffmpeg);
  const output = path.join(outDir, `${id}.jpg`);
  const source = path.resolve(input);

  const attempts: string[][] = [
    // Decode from the start, then take a frame one second in.
    [...prefix, "-y", "-i", source, "-ss", "1", "-frames:v", "1", "-q:v", "3", output],
    // Nothing at one second: take whatever the first frame is.
    [...prefix, "-y", "-i", source, "-frames:v", "1", "-q:v", "3", output],
  ];

  let lastError: unknown;
  for (const args of attempts) {
    try {
      await run(bin, args, { timeoutMs: 120_000 });
      if (fs.existsSync(output) && fs.statSync(output).size > 1000) return output;
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(
    `Could not extract a thumbnail from ${path.basename(source)}: ${
      lastError instanceof Error ? lastError.message.split("\n")[0] : lastError
    }`,
  );
}

export async function checkTooling(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const probes: Array<[string, string, string[]]> = [
    ["ffmpeg", env.ffmpeg, ["-version"]],
    ["ffprobe", env.ffprobe, ["-version"]],
    ["yt-dlp", env.ytDlp, ["--version"]],
  ];
  for (const [name, cmd, args] of probes) {
    const { bin, prefix } = splitCmd(cmd);
    try {
      const { stdout } = await run(bin, [...prefix, ...args], { timeoutMs: 30_000 });
      out[name] = stdout.trim().split("\n")[0];
    } catch (err) {
      out[name] = `MISSING (${err instanceof Error ? err.message.split("\n")[0] : err})`;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Transcripts                                                         */
/* ------------------------------------------------------------------ */

export type Cue = { start: number; end: number; text: string };

/** "00:01:23.456" -> seconds */
function parseTimestamp(value: string): number {
  const [h, m, s] = value.split(":");
  return Number(h) * 3600 + Number(m) * 60 + parseFloat(s);
}

/** Parses WebVTT into cues, dropping duplicate rolling-caption lines. */
export function parseVtt(vtt: string): Cue[] {
  const cues: Cue[] = [];
  let lastText = "";

  for (const block of vtt.replace(/\r/g, "").split("\n\n")) {
    const lines = block.split("\n").filter(Boolean);
    const timing = lines.find((l) => l.includes("-->"));
    if (!timing) continue;

    const [from, to] = timing.split("-->").map((t) => t.trim().split(" ")[0]);
    const text = lines
      .filter((l) => !l.includes("-->") && !/^\d+$/.test(l) && !l.startsWith("WEBVTT"))
      // YouTube auto-captions carry inline karaoke tags.
      .map((l) => l.replace(/<[^>]+>/g, "").trim())
      .filter(Boolean)
      .join(" ")
      .trim();

    if (!text || text === lastText) continue;
    lastText = text;
    cues.push({ start: parseTimestamp(from), end: parseTimestamp(to), text });
  }
  return cues;
}

/**
 * Removes the repeated words in a rolling caption track.
 *
 * YouTube auto-captions scroll: each cue re-states the tail of the one before
 * it and adds a word or two. Dropping only exact duplicates, as parseVtt does,
 * leaves every phrase on screen two or three times over. On a four-hour
 * podcast that measured 66% of the transcript - 150k tokens of the same
 * sentences, read and paid for repeatedly - and it also burned each word into
 * the finished video several times, because cuesToWords reads these same cues.
 *
 * The fix is per cue: strip the longest prefix that the previous cue already
 * said, and move `start` forward to where the surviving words actually begin.
 */
export function deoverlapCues(cues: Cue[]): Cue[] {
  const out: Cue[] = [];
  let previous: string[] = [];

  for (const cue of cues) {
    const words = cue.text.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    // Longest suffix of the previous cue that opens this one.
    let overlap = Math.min(previous.length, words.length);
    for (; overlap > 0; overlap--) {
      const tail = previous.slice(previous.length - overlap).join(" ").toLowerCase();
      const head = words.slice(0, overlap).join(" ").toLowerCase();
      if (tail === head) break;
    }

    previous = words;

    const fresh = words.slice(overlap);
    if (fresh.length === 0) continue;

    // The new words sit at the end of the cue's span, not across all of it,
    // so the caption highlight stays on the speech rather than running early.
    const span = Math.max(0.2, cue.end - cue.start);
    const start = cue.start + span * (overlap / words.length);

    out.push({ start, end: Math.max(start + 0.2, cue.end), text: fresh.join(" ") });
  }

  return out;
}

/**
 * Fetches an existing caption track WITHOUT downloading the video.
 *
 * Captions are kilobytes and videos are gigabytes, so this runs first: the
 * agent chooses a segment from the transcript, and only then do we pay to
 * download. Returns null when the video carries no usable captions.
 */
export async function fetchTranscript(
  url: string,
  id: string,
): Promise<{ cues: Cue[]; title: string; durationSec: number } | null> {
  ensureDirs();
  const { bin, prefix } = splitCmd(env.ytDlp);
  const template = path.join(rawDir, `${id}.%(ext)s`);

  const { stdout } = await run(
    bin,
    [
      ...prefix,
      ...ytdlpAuth(),
      "--skip-download",
      "--write-auto-sub",
      "--write-sub",
      // A single language: asking for several triggers HTTP 429.
      "--sub-langs",
      "en",
      "--sub-format",
      "vtt",
      "--no-warnings",
      "--print-json",
      "-o",
      template,
      url,
    ],
    { timeoutMs: 5 * 60_000 },
  );

  const line = stdout.trim().split("\n").find((l) => l.trim().startsWith("{"));
  const meta = line ? (JSON.parse(line) as { title?: string; duration?: number }) : {};

  const vttFile = fs
    .readdirSync(rawDir)
    .filter((f) => f.startsWith(`${id}.`) && f.endsWith(".vtt"))
    .map((f) => path.join(rawDir, f))[0];

  if (!vttFile) return null;

  const cues = deoverlapCues(parseVtt(fs.readFileSync(vttFile, "utf8")));
  if (cues.length === 0) return null;

  return {
    cues,
    title: meta.title ?? id,
    durationSec: meta.duration ?? cues[cues.length - 1].end,
  };
}

/**
 * Deletes the caption files fetched for one id.
 *
 * Reading a URL to answer a question in chat leaves the same .vtt behind that
 * producing a clip does, and those reads are not tied to a clip that anything
 * will ever clean up after.
 */
export function clearTranscriptFiles(id: string) {
  if (!fs.existsSync(rawDir)) return;
  for (const f of fs.readdirSync(rawDir)) {
    if (f.startsWith(`${id}.`) && f.endsWith(".vtt")) {
      try {
        fs.unlinkSync(path.join(rawDir, f));
      } catch {
        // A locked file is not worth failing a chat reply over.
      }
    }
  }
}

/** Renders cues as "[mm:ss] text" lines for the model to read. */
export function renderTranscript(cues: Cue[]): string {
  return cues
    .map((c) => {
      const m = Math.floor(c.start / 60);
      const s = Math.floor(c.start % 60);
      return `[${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}] ${c.text}`;
    })
    .join("\n");
}

export type SourceInfo = {
  title: string | null;
  durationSec: number | null;
  /** True while the stream is still going out. */
  isLive: boolean;
  /** True once a stream has ended but YouTube is still rebuilding the VOD. */
  wasLive: boolean;
  uploader: string | null;
};

/**
 * Asks what a URL actually is before the pipeline commits to it.
 *
 * A livestream in progress reports no duration and carries no captions, so
 * every later step fails in a way that reads like a broken source rather than
 * a stream that simply has not finished yet. One cheap metadata call up front
 * turns that into an answer the owner can act on.
 */
export async function probeSource(url: string): Promise<SourceInfo | null> {
  const { bin, prefix } = splitCmd(env.ytDlp);
  try {
    const { stdout } = await run(
      bin,
      [
        ...prefix,
        ...ytdlpAuth(),
        "--skip-download",
        "--no-playlist",
        "--no-warnings",
        "--print",
        "%(title)s\t%(duration)s\t%(is_live)s\t%(was_live)s\t%(uploader)s",
        url,
      ],
      { timeoutMs: 3 * 60_000 },
    );

    const line = stdout.trim().split("\n").filter(Boolean).pop();
    if (!line) return null;

    const [title, duration, isLive, wasLive, uploader] = line.split("\t");
    const seconds = Number(duration);

    return {
      title: title && title !== "NA" ? title : null,
      durationSec: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
      isLive: isLive === "True",
      wasLive: wasLive === "True",
      uploader: uploader && uploader !== "NA" ? uploader : null,
    };
  } catch {
    return null;
  }
}

/**
 * Reads a remote video's duration without downloading it.
 *
 * Needed before picking a section: asking for 60s-105s of a 50-second film
 * makes yt-dlp emit an empty container, which then fails deep inside ffmpeg
 * with an unhelpful filtergraph error.
 */
export async function probeRemoteDuration(url: string): Promise<number | null> {
  const { bin, prefix } = splitCmd(env.ytDlp);
  try {
    const { stdout } = await run(
      bin,
      [...prefix, ...ytdlpAuth(), "--skip-download", "--no-warnings", "--print", "%(duration)s", url],
      { timeoutMs: 3 * 60_000 },
    );
    const value = Number(stdout.trim().split("\n").pop());
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * True when the file actually holds a decodable video stream.
 *
 * Deliberately does NOT require a duration: archive .m4v containers routinely
 * report duration=N/A while being perfectly playable, and requiring it here
 * rejects good downloads.
 */
export async function hasVideoStream(file: string): Promise<boolean> {
  try {
    const meta = await probe(file);
    return meta.width > 0 && meta.height > 0 && meta.sizeBytes > 50_000;
  } catch {
    return false;
  }
}

/**
 * Stream-copies a file to repair its timestamps.
 *
 * yt-dlp section downloads emit containers with broken presentation
 * timestamps and no duration: ffprobe can still decode every frame, but
 * ffmpeg's -t reads the bad timestamps and stops after half a second. A
 * remux costs no quality and no real time, and restores both.
 */
export async function remux(input: string): Promise<string> {
  const { bin, prefix } = splitCmd(env.ffmpeg);
  const source = path.resolve(input);
  const target = source.replace(/\.[^.]+$/, "") + ".fixed.mp4";

  await run(
    bin,
    [
      ...prefix,
      "-y",
      "-fflags",
      "+genpts",
      "-i",
      source,
      "-c",
      "copy",
      "-avoid_negative_ts",
      "make_zero",
      target,
    ],
    { timeoutMs: 5 * 60_000 },
  );

  if (!fs.existsSync(target) || fs.statSync(target).size < 10_000) {
    // Repair failed; the caller is better off with the original than nothing.
    return source;
  }

  try {
    fs.unlinkSync(source);
  } catch {
    // Leaving the original behind is harmless.
  }
  return target;
}

/**
 * Turns caption cues into word timings for the renderer.
 *
 * Caption tracks are phrase-level, so word times are interpolated evenly
 * across each cue. That is an approximation, but at reading speed it lands
 * close enough that the highlight tracks the speech.
 *
 * Times come back relative to `startSec`, because the clip is cut from there.
 */
export function cuesToWords(
  cues: Cue[],
  startSec: number,
  endSec: number,
): Array<{ text: string; startMs: number; endMs: number }> {
  const out: Array<{ text: string; startMs: number; endMs: number }> = [];

  for (const cue of cues) {
    if (cue.end <= startSec || cue.start >= endSec) continue;

    const words = cue.text.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    const span = Math.max(0.2, cue.end - cue.start);
    const per = span / words.length;

    words.forEach((word, i) => {
      const wordStart = cue.start + per * i;
      const wordEnd = wordStart + per;
      if (wordEnd <= startSec || wordStart >= endSec) return;
      out.push({
        text: word,
        startMs: Math.max(0, (wordStart - startSec) * 1000),
        endMs: Math.max(0, (wordEnd - startSec) * 1000),
      });
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Frame sampling                                                      */
/* ------------------------------------------------------------------ */

export type SampledFrame = { atSec: number; path: string; base64: string };

/** Removes the extracted stills for one source once they are no longer needed. */
export function clearFrames(file: string) {
  const dir = path.join(
    mediaDir,
    "frames",
    path.basename(path.resolve(file), path.extname(file)),
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Resolves a page URL to the direct media file, without downloading it. */
export async function resolveMediaUrl(pageUrl: string): Promise<string | null> {
  const { bin, prefix } = splitCmd(env.ytDlp);
  try {
    const { stdout } = await run(
      bin,
      [
        ...prefix,
        ...ytdlpAuth(),
        "--no-warnings",
        "-f",
        "b[height<=720]/b",
        "--get-url",
        pageUrl,
      ],
      { timeoutMs: 3 * 60_000 },
    );
    const url = stdout.trim().split("\n").filter(Boolean).pop();
    return url && /^https?:\/\//i.test(url) ? url : null;
  } catch {
    return null;
  }
}

/**
 * Samples frames from a REMOTE video without downloading it.
 *
 * ffmpeg seeks over HTTP range requests, so each frame costs only the bytes
 * around that timestamp. That matters because the whole point of sampling is
 * to decide whether a film is worth downloading at all - fetching it first
 * would defeat the purpose.
 *
 * Each seek takes seconds and is network-bound rather than CPU-bound, so they
 * run concurrently.
 */
export async function sampleRemoteFrames(
  pageUrl: string,
  {
    durationSec,
    maxFrames = 24,
    width = 384,
    concurrency = 6,
    skipHeadSec = 20,
  }: {
    durationSec: number;
    maxFrames?: number;
    width?: number;
    concurrency?: number;
    skipHeadSec?: number;
  },
): Promise<SampledFrame[]> {
  ensureDirs();
  const dir = path.join(mediaDir, "frames", Buffer.from(pageUrl).toString("base64url").slice(0, 40));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  // Skip the opening titles and the closing credits: neither is ever the shot
  // we want, and sampling them wastes both time and vision tokens.
  const from = Math.min(skipHeadSec, durationSec * 0.1);
  const to = Math.max(from + 1, durationSec - 10);
  const step = (to - from) / maxFrames;

  const points: number[] = [];
  for (let i = 0; i < maxFrames; i++) {
    points.push(Math.round(from + step * i));
  }

  const { bin, prefix } = splitCmd(env.ffmpeg);

  async function grab(mediaUrl: string, atSec: number, results: SampledFrame[]) {
    const target = path.join(dir, `f${String(atSec).padStart(6, "0")}.jpg`);
    try {
      await run(
        bin,
        [
          ...prefix,
          "-y",
          // Seek BEFORE -i so ffmpeg range-requests instead of streaming.
          "-ss",
          String(atSec),
          "-i",
          mediaUrl,
          "-frames:v",
          "1",
          "-vf",
          `scale=${width}:-2`,
          "-q:v",
          "6",
          target,
        ],
        { timeoutMs: 90_000 },
      );
      if (fs.existsSync(target) && fs.statSync(target).size > 800) {
        results.push({
          atSec,
          path: target,
          base64: fs.readFileSync(target).toString("base64"),
        });
      }
    } catch {
      // A frame that will not decode is not worth failing the batch over.
    }
  }

  // Archive.org rejects the first burst of range requests against a file it
  // has not served recently, and every frame in the batch fails together. The
  // whole attempt is therefore retried rather than each frame: a single warm
  // request wakes the file up, and the second pass succeeds.
  for (let attempt = 0; attempt < 3; attempt++) {
    const mediaUrl = await resolveMediaUrl(pageUrl);
    if (!mediaUrl) return [];

    if (attempt > 0) {
      // Wake the file with one request before asking for many.
      const warm: SampledFrame[] = [];
      await grab(mediaUrl, points[Math.floor(points.length / 2)], warm);
    }

    const results: SampledFrame[] = [];
    // Back off the parallelism each time round; a narrower batch is more
    // likely to get through a throttle than a wide one.
    const batch = Math.max(2, Math.round(concurrency / (attempt + 1)));
    for (let i = 0; i < points.length; i += batch) {
      await Promise.all(points.slice(i, i + batch).map((at) => grab(mediaUrl, at, results)));
    }

    // A partial result is still usable; only a total failure is worth retrying.
    if (results.length > 0) return results.sort((a, b) => a.atSec - b.atSec);
  }

  return [];
}

/**
 * Judges whether a cut shot is actually watchable.
 *
 * The survey looks at one frame roughly every forty seconds and reports what
 * it sees there. The four or five seconds that then get downloaded from that
 * point are unverified: archive films fade to black between scenes, sit in fog
 * banks, and blow out to white steam. Roughly a third of the shots in the
 * first working render were black or featureless.
 *
 * This is deliberately arithmetic rather than another vision call - luma tells
 * you whether there is a picture, it costs nothing, and it cannot hallucinate
 * a carrier deck into an empty frame.
 *
 * Two things get rejected. Luma catches frames with nothing in them. Freeze
 * detection catches frames with the wrong thing in them: archive compilations
 * are stitched together from several films and carry a title card between
 * each, and a title card has excellent contrast, so it passes every luma test
 * there is. It is also the one thing on screen that is definitely not footage.
 * Static shots fail the same check, which is the point - a held frame is the
 * most boring thing an edit can contain.
 */
export type ShotQuality = { ok: boolean; reason: string };

export async function inspectShot(
  file: string,
  opts: { allowStatic?: boolean } = {},
): Promise<ShotQuality> {
  const { bin, prefix } = splitCmd(env.ffprobe);
  let stdout: string;
  try {
    ({ stdout } = await run(
      bin,
      [
        ...prefix,
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        // Just the file name, with ffprobe run from its own directory: a
        // Windows drive colon inside a filtergraph reads as a protocol
        // separator, and escaping it is not portable.
        `movie=${path.basename(file)},signalstats`,
        "-show_entries",
        "frame_tags=lavfi.signalstats.YAVG,lavfi.signalstats.YLOW,lavfi.signalstats.YHIGH",
        // Named output, NOT csv. ffprobe emits these tags in the order the
        // filter sets them (YLOW, YAVG, YHIGH), not the order they were asked
        // for, so reading a bare csv row positionally silently swaps the
        // average with the low percentile - and every shot of a subject lit
        // against a dark background then measures as pure black.
        "-of",
        "json",
      ],
      { cwd: path.dirname(path.resolve(file)), timeoutMs: 90_000 },
    ));
  } catch {
    // If it cannot be measured, let it through rather than losing a shot to a
    // probe failure.
    return { ok: true, reason: "not measured" };
  }

  type Row = { yavg: number; ylow: number; yhigh: number };
  let rows: Row[] = [];
  try {
    const parsed = JSON.parse(stdout) as {
      frames?: Array<{ tags?: Record<string, string> }>;
    };
    rows = (parsed.frames ?? [])
      .map((f) => ({
        yavg: Number(f.tags?.["lavfi.signalstats.YAVG"]),
        ylow: Number(f.tags?.["lavfi.signalstats.YLOW"]),
        yhigh: Number(f.tags?.["lavfi.signalstats.YHIGH"]),
      }))
      .filter((r) => Number.isFinite(r.yavg) && Number.isFinite(r.ylow) && Number.isFinite(r.yhigh));
  } catch {
    return { ok: true, reason: "not measured" };
  }

  if (rows.length === 0) return { ok: true, reason: "not measured" };

  let black = 0;
  let blown = 0;
  let flat = 0;
  for (const { yavg, ylow, yhigh } of rows) {
    // YHIGH rather than YAVG decides emptiness. A studio interview is a lit
    // subject on a black background: most of the frame is genuinely near zero,
    // so the average is very dark while the picture is perfectly exposed. What
    // separates that from an empty frame is whether anything in it is lit at
    // all, which is what the top percentile answers.
    if (yhigh < 40) black++;
    else if (yavg > 205) blown++;
    else if (yhigh - ylow < 22) flat++;
  }

  const n = rows.length;
  // A quarter of the shot being unusable is enough: the eye lands on the worst
  // moment, not the average one.
  const limit = n * 0.25;
  if (black > limit) return { ok: false, reason: `${Math.round((black / n) * 100)}% black` };
  if (blown > limit) return { ok: false, reason: `${Math.round((blown / n) * 100)}% blown out` };
  if (flat > limit) return { ok: false, reason: `${Math.round((flat / n) * 100)}% featureless` };

  // Freeze detection catches a title card held between the films in an archive
  // compilation - excellent contrast, passes every luma test, and definitely
  // not footage. A locked-off camera on someone talking trips the same check
  // by design, so a talking head is exempt from this one alone.
  if (opts.allowStatic) return { ok: true, reason: "usable" };

  if (await isFrozen(file)) return { ok: false, reason: "static - title card or held frame" };

  return { ok: true, reason: "usable" };
}

/**
 * True when the shot stops moving for half a second or more.
 *
 * -40dB is measured rather than chosen: archive film carries enough grain that
 * a title card is never literally identical frame to frame, so the stricter
 * -50dB catches nothing at all, while -30dB starts flagging slow footage that
 * is perfectly good. At -40dB a reel of eleven shots separated cleanly - the
 * title card fired three times and the eight real shots fired none.
 */
async function isFrozen(file: string): Promise<boolean> {
  const { bin, prefix } = splitCmd(env.ffmpeg);
  try {
    const { stderr } = await run(
      bin,
      [
        ...prefix,
        "-hide_banner",
        "-i",
        path.resolve(file),
        "-vf",
        "freezedetect=n=-40dB:d=0.5",
        "-map",
        "0:v",
        "-f",
        "null",
        "-",
      ],
      { timeoutMs: 90_000 },
    );
    return stderr.includes("freeze_start");
  } catch {
    // Unmeasurable is not a reason to throw away footage.
    return false;
  }
}

/**
 * Pulls every shot in a list out of a source film.
 *
 * Shots are grouped into shared download windows first. A fifteen-shot edit
 * would otherwise mean fifteen separate range requests against the archive,
 * where five windows cover the same material - the shots are then cut out of
 * those windows locally, which is free.
 *
 * This replaces the old splitIntoBeats, which divided one continuous take into
 * equal consecutive slices. That produced three shots of the same locked-off
 * view and is the reason the finished clips read as static.
 */
export async function fetchShots(
  pageUrl: string,
  id: string,
  shots: Array<{ atSec: number; startMs: number; endMs: number }>,
  opts: {
    keepAudio?: boolean;
    concurrency?: number;
    localFile?: string;
    /** Set for talking-head footage, where stillness and flat light are correct. */
    allowStatic?: boolean;
  } = {},
): Promise<Array<{ path: string; durationSec: number } | null>> {
  ensureDirs();
  if (shots.length === 0) return [];

  const keepAudio = opts.keepAudio ?? false;
  const concurrency = opts.concurrency ?? 3;

  // A shot needs its own length plus a little slack, so a cut never runs off
  // the end of the window it was taken from.
  // Extra slack beyond the shot length: a shot now starts early and is held
  // open underneath the next one while that blends in, so it plays for longer
  // than its own span.
  const needed = shots.map((sh) => Math.max(1.6, (sh.endMs - sh.startMs) / 1000 + 1.4));

  // Already on disk - a DVIDS asset, or anything the caller fetched whole.
  // There is nothing to range-request, so cut straight out of the file.
  if (opts.localFile) {
    const source = path.resolve(opts.localFile);
    const total = (await probe(source)).durationSec;
    const cut: Array<{ path: string; durationSec: number } | null> = [];

    for (let i = 0; i < shots.length; i++) {
      const offset = Math.max(0, Math.min(shots[i].atSec, Math.max(0, total - needed[i])));
      const take = total > 0 ? Math.min(needed[i], total - offset) : needed[i];
      if (take < 0.5) {
        cut.push(null);
        continue;
      }
      const target = path.join(rawDir, `${id}-shot${i}.mp4`);
      try {
        await cutShot(source, target, offset, take, keepAudio);
        cut.push(await keepIfUsable(target, take, { allowStatic: opts.allowStatic }));
      } catch {
        cut.push(null);
      }
    }
    return cut;
  }

  // Group shots whose source timestamps are close enough to share one fetch.
  type Window = { from: number; to: number; members: number[] };
  const order = shots.map((_, i) => i).sort((a, b) => shots[a].atSec - shots[b].atSec);
  const windows: Window[] = [];

  for (const i of order) {
    // Start exactly where the survey looked. Backing off even half a second
    // can land on a different shot in a fast-cut film, which is how a moment
    // the model described as a deck launch arrives as a frame of smoke.
    const from = Math.max(0, shots[i].atSec);
    const to = from + needed[i] + 0.5;
    const last = windows[windows.length - 1];
    // 40s is roughly where one larger range request stops being cheaper than
    // two smaller ones.
    if (last && from <= last.to + 6 && to - last.from <= 40) {
      last.to = Math.max(last.to, to);
      last.members.push(i);
    } else {
      windows.push({ from, to, members: [i] });
    }
  }

  const results: Array<{ path: string; durationSec: number } | null> = shots.map(() => null);

  async function handle(window: Window, index: number) {
    // Archive.org throttles repeated range requests against the same file, and
    // a throttled window takes every shot in it down with it. Losing a window
    // is not cosmetic - the caller backfills the hole by repeating another
    // shot, so enough failures turn a nine-shot edit back into a slideshow.
    // Two retries with a widening pause is the difference.
    let source: string | null = null;
    for (let attempt = 0; attempt < 3 && !source; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 4000));
      }
      try {
        const dl = await downloadVideo(pageUrl, `${id}-w${index}`, {
          section: { startSec: window.from, durationSec: window.to - window.from },
        });
        source = dl.path;
      } catch {
        // Try again; only a total failure drops the window.
      }
    }
    if (!source) return;

    const windowLength = (await probe(source)).durationSec;

    for (const i of window.members) {
      // The section download starts at window.from, so the offset inside the
      // file is relative to that, not to the original film.
      const offset = Math.max(0, shots[i].atSec - window.from);
      const want = needed[i];
      if (windowLength > 0 && offset >= windowLength - 0.4) continue;
      const take = windowLength > 0 ? Math.min(want, windowLength - offset) : want;
      if (take < 0.5) continue;

      const target = path.join(rawDir, `${id}-shot${i}.mp4`);
      try {
        await cutShot(source, target, offset, take, keepAudio);
      } catch {
        continue;
      }
      results[i] = await keepIfUsable(target, take, { allowStatic: opts.allowStatic });
    }

    try {
      fs.unlinkSync(source);
    } catch {
      // The window file is large but a leftover is not fatal.
    }
  }

  // Windows are fetched a few at a time: the archive throttles, and a burst of
  // fifteen range requests is slower than three at a time.
  for (let i = 0; i < windows.length; i += concurrency) {
    await Promise.all(
      windows.slice(i, i + concurrency).map((w, k) => handle(w, i + k)),
    );
  }

  return results;
}

/**
 * Keeps a freshly cut shot only if there is a picture in it, and deletes it
 * otherwise so a later pass can put something else in its place.
 */
async function keepIfUsable(
  target: string,
  durationSec: number,
  opts: { allowStatic?: boolean } = {},
): Promise<{ path: string; durationSec: number } | null> {
  if (!fs.existsSync(target) || fs.statSync(target).size <= 10_000) return null;
  const quality = await inspectShot(target, opts);
  if (quality.ok) return { path: target, durationSec };
  try {
    fs.unlinkSync(target);
  } catch {
    // A rejected shot left on disk is harmless; it is simply never referenced.
  }
  return null;
}

/** Cuts one shot, re-encoding so its length is exactly what was asked for. */
async function cutShot(
  source: string,
  target: string,
  offsetSec: number,
  durationSec: number,
  keepAudio: boolean,
): Promise<void> {
  const { bin, prefix } = splitCmd(env.ffmpeg);
  await run(
    bin,
    [
      ...prefix,
      "-y",
      "-v",
      "error",
      "-ss",
      offsetSec.toFixed(3),
      "-i",
      path.resolve(source),
      "-t",
      durationSec.toFixed(3),
      // Re-encode: a stream copy would snap to keyframes and the shot would
      // not line up with the narration timing the composition expects.
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      // A constant frame rate keeps Remotion from drifting on variable-rate
      // archive transfers.
      "-r",
      "30",
      ...(keepAudio ? ["-c:a", "aac", "-b:a", "128k"] : ["-an"]),
      target,
    ],
    { timeoutMs: 5 * 60_000 },
  );
}
