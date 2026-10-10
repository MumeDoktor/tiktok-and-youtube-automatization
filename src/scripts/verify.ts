/**
 * Typecheck + production build, WITHOUT touching a running dev server.
 *
 *   npm run verify
 *
 * `next build` and `next dev` both write to .next by default, so building while
 * the dev server is running deletes the chunks it is serving - the page then
 * fails with "Cannot find module './611.js'" and loses its stylesheet. This
 * builds into a throwaway directory instead, so it is always safe to run.
 */
import { spawn } from "node:child_process";

const DIST = ".next-verify";

// Record<string, string> rather than NodeJS.ProcessEnv: Next augments that type
// to require NODE_ENV, which a partial override does not supply.
function run(command: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: true,
      env: { ...process.env, ...env },
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function main() {
  console.log("\n> typecheck\n");
  const tsc = await run("npx", ["tsc", "--noEmit"]);
  if (tsc !== 0) {
    console.error("\n  Typecheck failed.\n");
    process.exit(tsc);
  }

  console.log(`\n> build (into ${DIST}, leaving .next alone)\n`);
  const build = await run("npx", ["next", "build"], { NEXT_DIST_DIR: DIST });
  if (build !== 0) {
    console.error("\n  Build failed.\n");
    process.exit(build);
  }

  console.log("\n  Verify passed. The running dev server was not disturbed.\n");
}

void main();
