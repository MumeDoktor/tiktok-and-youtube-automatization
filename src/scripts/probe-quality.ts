import "../worker/load-env";
import fs from "node:fs";
import path from "node:path";
import { inspectShot, rawDir } from "../lib/media";

async function main() {
  const files = fs.readdirSync(rawDir).filter((f) => f.includes("-shot")).sort();
  for (const f of files) {
    const q = await inspectShot(path.join(rawDir, f));
    console.log(`  ${q.ok ? "KEEP  " : "REJECT"}  ${f.padEnd(28)} ${q.reason}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
