/**
 * Starts the dashboard and the background worker together.
 *
 *   npm run dev
 *
 * They are separate processes because the worker does slow work - downloading
 * video, running ffmpeg - that a web request cannot hold open. Running them
 * from one command just saves you a second terminal.
 */
import { spawn, type ChildProcess } from "node:child_process";

type Job = { name: string; color: string; command: string; args: string[] };

const RESET = "\x1b[0m";

const JOBS: Job[] = [
  { name: "web   ", color: "\x1b[36m", command: "npx", args: ["next", "dev"] },
  { name: "worker", color: "\x1b[35m", command: "npx", args: ["tsx", "src/worker/index.ts"] },
];

const children: ChildProcess[] = [];
let shuttingDown = false;

function prefix(job: Job, chunk: Buffer) {
  const text = chunk.toString();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    process.stdout.write(`${job.color}${job.name}${RESET} │ ${line}\n`);
  }
}

function stopAll(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  // Give them a moment to exit cleanly before the process ends.
  setTimeout(() => process.exit(code), 400);
}

for (const job of JOBS) {
  const child = spawn(job.command, job.args, {
    shell: true,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (c: Buffer) => prefix(job, c));
  child.stderr?.on("data", (c: Buffer) => prefix(job, c));

  child.on("exit", (code) => {
    if (shuttingDown) return;
    process.stdout.write(
      `${job.color}${job.name}${RESET} │ exited with code ${code}. Stopping everything.\n`,
    );
    // One half dying without the other is a confusing half-working state.
    stopAll(code ?? 1);
  });

  children.push(child);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => stopAll(0));
}

process.stdout.write(
  "\n  Dashboard on http://localhost:3000, worker running alongside.\n" +
    "  Ctrl+C stops both.\n\n",
);
