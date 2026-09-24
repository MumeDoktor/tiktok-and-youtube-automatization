import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { env } from "./env";
import { mediaDir } from "./media";

/**
 * The bridge to ai_aget_ae - the editor that builds a clip inside After Effects.
 *
 * Like Remotion it lives in its own workspace and is driven as a process. The
 * difference is what comes back: not a finished file but an edit sitting in an
 * After Effects project, for a person to review and export. The export is
 * picked up from the run's export folder afterwards (see collectAeExports).
 *
 * Runs live under the media directory rather than inside the editor, so the
 * exported file lands inside the one folder the file route will serve.
 */

export const aeEditorDir = path.resolve(env.aeEditorDir);

export function aeRunDir(clipId: string): string {
  return path.join(mediaDir, "ae", clipId);
}

export function aeExportDir(clipId: string): string {
  return path.join(aeRunDir(clipId), "export");
}

export function aeEditorAvailable(): boolean {
  return (
    fs.existsSync(path.join(aeEditorDir, "src", "pipeline.ts")) &&
    fs.existsSync(path.join(aeEditorDir, "node_modules", "typescript"))
  );
}

/** Whether cuts go to After Effects. Falls back to Remotion when the editor is not installed. */
export function useAeEditor(): boolean {
  return env.editorBackend === "ae" && aeEditorAvailable();
}

/** Mirrors the outcome ai_aget_ae's src/pipeline.ts writes to result.json. */
export type AeOutcome =
  | {
      status: "built";
      comp: string;
      aep: string;
      exportDir: string;
      durationSec: number;
      thesis: string;
      treatments: number;
      captions: number;
      segments: number;
      builtAt: string;
    }
  | { status: "waiting_for_ae"; reason: "bridge_not_running" | "project_open"; message: string }
  | { status: "failed"; stage: string; error: string };

export function readAeOutcome(clipId: string): AeOutcome | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(aeRunDir(clipId), "result.json"), "utf8")) as AeOutcome;
  } catch {
    return null;
  }
}

/**
 * Is After Effects running the bridge right now?
 *
 * Read from the heartbeat the bridge rewrites every couple of seconds, so it
 * costs no command and needs no editor process.
 */
export function aeBridgeAlive(): boolean {
  try {
    const status = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".ae-agent-bridge", "status.json"), "utf8"),
    ) as { alive?: boolean; at?: number };
    return Boolean(status.alive) && Date.now() - (status.at ?? 0) < 15_000;
  } catch {
    return false;
  }
}

/**
 * How long to ask the editor to cut to.
 *
 * Its story pass refuses an edit that keeps every span - "a cut that keeps
 * everything is not a cut" - so the target has to sit under the source's own
 * length, or a segment this app already chose tightly would fail outright.
 */
export function aeTargetSec(sourceSec: number): number {
  return Math.max(8, Math.min(env.clipMaxSec, Math.round(sourceSec * AE_KEEP)));
}

/** How much of what it is given the editor is asked to keep - see aeTargetSec. */
const AE_KEEP = 0.85;

/**
 * How long the material going into the edit should run, for the finished video
 * to land inside CLIP_MIN_SEC-CLIP_MAX_SEC.
 *
 * Remotion renders what it is given, so that is the window itself. After
 * Effects cuts to a share of it and then lands a little under, so it needs
 * more going in - an 8 second segment came out as a 4.9 second video.
 */
export function sourceWindowSec(): { minSec: number; maxSec: number } {
  if (!useAeEditor()) return { minSec: env.clipMinSec, maxSec: env.clipMaxSec };
  return {
    minSec: Math.ceil(env.clipMinSec / AE_KEEP) + 2,
    // Generous at the top on purpose. The editor cuts its target out of
    // whatever it is given, so a story that takes a minute to tell is usable -
    // and a tight ceiling here throws those away before anyone hears them,
    // which is most of what "nothing worth cutting" used to mean.
    maxSec: Math.round(env.clipMaxSec * 2.5),
  };
}

function runEditorNode(
  args: string[],
  onLine: (line: string) => void,
  timeoutMs: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: aeEditorDir,
      env: process.env,
      windowsHide: true,
    });

    let pending = "";
    const feed = (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onLine(line);
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`The After Effects editor timed out after ${Math.round(timeoutMs / 60_000)} minutes`));
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not start the After Effects editor: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (pending.trim()) onLine(pending);
      resolve(code ?? 1);
    });
  });
}

/**
 * Compiles the editor, so its latest code is what runs. Returns why it could
 * not, or null.
 *
 * The editor is under active development and a type error somewhere unrelated
 * still emits JavaScript, so only a missing entry point is fatal here.
 */
async function compileEditor(entry: string): Promise<string | null> {
  await runEditorNode(
    [path.join("node_modules", "typescript", "bin", "tsc")],
    () => {},
    5 * 60_000,
  ).catch(() => 1);
  return fs.existsSync(path.join(aeEditorDir, "dist", entry))
    ? null
    : `The editor at ${aeEditorDir} did not compile - run "npx tsc" there to see why.`;
}

export type AeExportOutcome =
  | { status: "exported"; file: string }
  | { status: "waiting_for_ae"; message: string }
  | { status: "failed"; error: string };

/** The newest finished video in a clip's export folder, if there is one. */
export function newestAeExport(clipId: string): string | null {
  const dir = aeExportDir(clipId);
  if (!fs.existsSync(dir)) return null;
  const newest = fs
    .readdirSync(dir)
    .filter((f) => /\.(mp4|mov)$/i.test(f))
    .map((f) => ({ full: path.join(dir, f), stat: fs.statSync(path.join(dir, f)) }))
    .filter((f) => f.stat.size >= 10_000)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0];
  return newest?.full ?? null;
}

/**
 * Renders a built edit to the clip's export folder, with no one reviewing it.
 *
 * ai_aget_ae's exportEdit renders the picture in After Effects, rebuilds the
 * sound from the plan and muxes the two - the step a person used to do by hand
 * after scrubbing the timeline.
 */
export async function runAeExport(opts: {
  clipId: string;
  onProgress: (message: string) => void;
}): Promise<AeExportOutcome> {
  const compileError = await compileEditor("exportEdit.js");
  if (compileError) return { status: "failed", error: compileError };

  const tail: string[] = [];
  const startedAt = Date.now();
  let code: number;
  try {
    code = await runEditorNode(
      [
        "--env-file-if-exists=.env",
        path.join("dist", "exportEdit.js"),
        `--run=${aeRunDir(opts.clipId)}`,
      ],
      (line) => {
        tail.push(line);
        if (tail.length > 40) tail.shift();
        if (/^\s+(picture|audio|comp)\s/.test(line)) opts.onProgress(`Export: ${line.trim()}`);
      },
      60 * 60_000,
    );
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }

  if (code === 3) {
    return {
      status: "waiting_for_ae",
      message: "After Effects is not running the bridge, so the edit cannot be rendered.",
    };
  }
  const file = newestAeExport(opts.clipId);
  if (code !== 0 || !file || fs.statSync(file).mtimeMs < startedAt - 1000) {
    return {
      status: "failed",
      error: `The export exited ${code}:\n${tail.slice(-12).join("\n")}`,
    };
  }
  return { status: "exported", file };
}

/**
 * Hands one video to the editor and returns what it did with it.
 *
 * Every progress line it reports is passed on as it arrives - an edit takes
 * many minutes, and the clip's progress trail is where the owner watches it.
 */
export async function runAeEditor(opts: {
  clipId: string;
  sourcePath: string;
  targetSec: number;
  musicPath?: string | null;
  onProgress: (message: string) => void;
}): Promise<AeOutcome> {
  const runDir = aeRunDir(opts.clipId);
  fs.mkdirSync(runDir, { recursive: true });

  const compileError = await compileEditor("pipeline.js");
  if (compileError) return { status: "failed", stage: "compile", error: compileError };

  const args = [
    "--env-file-if-exists=.env",
    path.join("dist", "pipeline.js"),
    `--source=${path.resolve(opts.sourcePath)}`,
    `--run=${runDir}`,
    `--target=${opts.targetSec}`,
  ];
  if (opts.musicPath) args.push(`--music=${path.resolve(opts.musicPath)}`);

  const tail: string[] = [];
  const startedAt = Date.now();
  try {
    await runEditorNode(
      args,
      (line) => {
        if (line.startsWith("@@progress ")) {
          opts.onProgress(line.slice("@@progress ".length));
          return;
        }
        tail.push(line);
        if (tail.length > 40) tail.shift();
      },
      2 * 60 * 60_000,
    );
  } catch (err) {
    return {
      status: "failed",
      stage: "pipeline",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Only an outcome written by THIS run counts. A process that died hard leaves
  // the previous run's result.json behind, which could say anything.
  const resultPath = path.join(runDir, "result.json");
  const fresh = fs.existsSync(resultPath) && fs.statSync(resultPath).mtimeMs >= startedAt - 1000;
  const outcome = fresh ? readAeOutcome(opts.clipId) : null;
  return (
    outcome ?? {
      status: "failed",
      stage: "pipeline",
      error: `The editor stopped without reporting an outcome:\n${tail.slice(-12).join("\n")}`,
    }
  );
}
