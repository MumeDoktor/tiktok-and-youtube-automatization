/** Hands a downloaded podcast beat to the local Codex video agent. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { env } from "./env";
import { aeEditorDir } from "./ae-editor";

export function useCodexEditor(): boolean {
  return env.editorBackend === "codex";
}

function safeId(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid clip id");
  return id;
}

export function codexRunDir(clipId: string): string {
  return path.join(aeEditorDir, "runs", "codex-jobs", safeId(clipId));
}

/** Desktop installs put codex.exe in a versioned directory absent from npm's PATH. */
export function codexCommand(): string {
  if (process.env.CODEX_CMD?.trim()) return process.env.CODEX_CMD.trim();
  const localAppData = process.env.LOCALAPPDATA;
  if (process.platform === "win32" && localAppData) {
    const binDir = path.join(localAppData, "OpenAI", "Codex", "bin");
    if (fs.existsSync(binDir)) {
      const candidates = [path.join(binDir, "codex.exe")];
      for (const entry of fs.readdirSync(binDir, { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.push(path.join(binDir, entry.name, "codex.exe"));
      }
      const installed = candidates
        .filter((candidate) => fs.existsSync(candidate))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (installed[0]) return installed[0];
    }
  }
  return process.platform === "win32" ? "codex.exe" : "codex";
}

function childEnv(): NodeJS.ProcessEnv {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL/i.test(key)) delete clean[key];
  }
  return clean;
}

function promptFor(opts: { sourcePath: string; runDir: string; hook: string; caption: string }): string {
  const exemplar = path.join(aeEditorDir, "runs", "sr71-audio-first");
  const hasExemplar = fs.existsSync(path.join(exemplar, "render_story.py"));
  return [
    "Create one finished vertical podcast/storytelling video from the source below.",
    "The speaker's complete audio is the spine of the edit. Keep the spoken story and its payoff.",
    "Use the original podcast picture where seeing the person adds emotion or credibility.",
    "For technical or visual claims, create source-specific visual assets and scenes from a varied mix of still images, animated diagrams, maps, labels, transitions and subtle sound cues.",
    "Make at least one visual asset that could only belong to this story. Use an image when it explains more than text or shapes alone; do not reuse the same asset pattern across videos.",
    "Choose the scene switches by actual spoken words, not a fixed every-N-seconds rhythm.",
    "Avoid repeating the same image, effect or caption layout. Give each key claim enough time to be understood.",
    "Mix podcast and visual-story scenes; aim for a meaningful balance, not a rigid percentage.",
    "Transcribe locally with word timings when possible. Keep captions readable in the phone safe area.",
    "Use source video frames only for podcast moments. Do not merely put effects over the whole original video.",
    "Use local tools for compositing and render. Generate or source fresh visual assets where the story needs them.",
    "Work economically: reuse a working renderer when it fits, avoid repeated full-file output, and rerender only to fix a specific issue.",
    "No After Effects project is required. Output H.264/AAC MP4 with sound at 1080x1920, 9:16 aspect ratio.",
    `Source video (read-only): ${opts.sourcePath}`,
    `Story hook: ${opts.hook}`,
    `Posting caption for context: ${opts.caption}`,
    `Job directory: ${opts.runDir}`,
    `Required deliverable: ${path.join(opts.runDir, "final.mp4")}`,
    hasExemplar ? `Quality reference and reusable rendering method: ${path.join(exemplar, "render_story.py")}; example final video: ${path.join(exemplar, "SR71_audio_first_1080x1920.mp4")}. Use fresh scene design and assets for THIS story, with podcast moments.` : "",
    "Before finishing, probe the MP4: ensure video and audio streams exist, duration covers the story, and the final file is readable.",
    "Return a concise result. Do not publish anything; the calling worker handles publishing.",
  ].filter(Boolean).join("\n");
}

export async function runCodexEditor(opts: {
  clipId: string;
  sourcePath: string;
  hook: string;
  caption: string;
  onProgress: (message: string) => void;
}): Promise<string> {
  const runDir = codexRunDir(opts.clipId);
  fs.mkdirSync(runDir, { recursive: true });
  const final = path.join(runDir, "final.mp4");
  if (fs.existsSync(final) && fs.statSync(final).size > 100_000) return final;

  const args = [
    "exec", "--ignore-user-config", "--skip-git-repo-check", "--ephemeral",
    "--approve-for-me",
    "--model", "gpt-6-sol", "-c", "model_reasoning_effort=medium",
    "-C", runDir, "-",
  ];
  opts.onProgress("Codex is planning the podcast and visual-story scenes");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(codexCommand(), args, {
      cwd: runDir, env: childEnv(), windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const log = fs.createWriteStream(path.join(runDir, "codex.log"), { flags: "a" });
    let tail = "", settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      log.end();
      reject(new Error(message));
    };
    const timer = setTimeout(() => {
      child.kill();
      fail("Codex video job timed out after 45 minutes");
    }, 45 * 60_000);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk: Buffer) => {
        const line = chunk.toString();
        log.write(line);
        tail = (tail + line).slice(-4000);
      });
    }
    child.on("error", (error) => { clearTimeout(timer); fail(`Codex could not start: ${error.message}`); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      log.end();
      if (code !== 0) return fail(`Codex video job exited ${code}: ${tail.slice(-1500)}`);
      settled = true;
      resolve();
    });
    child.stdin.on("error", () => { /* close/error handles process failures */ });
    child.stdin.end(promptFor({ ...opts, runDir }));
  });
  if (!fs.existsSync(final) || fs.statSync(final).size < 100_000) {
    throw new Error(`Codex finished without a valid final.mp4; inspect ${path.join(runDir, "codex.log")}`);
  }
  return final;
}
