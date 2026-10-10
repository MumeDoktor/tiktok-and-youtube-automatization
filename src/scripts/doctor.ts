/**
 * Preflight check. Run before connecting accounts:
 *
 *   npm run doctor
 *
 * Verifies every prerequisite the OAuth handshake depends on, so a
 * misconfiguration surfaces here instead of as an opaque error on TikTok.
 */
import "../worker/load-env";

import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { accounts, agents, apiUsage } from "../db/schema";
import { env } from "../lib/env";

type Status = "ok" | "warn" | "fail";

const results: Array<{ status: Status; label: string; detail: string }> = [];

function add(status: Status, label: string, detail: string) {
  results.push({ status, label, detail });
}

async function reachable(
  url: string,
): Promise<{ ok: boolean; detail: string; ngrokError?: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal, redirect: "manual" });
    clearTimeout(timer);

    // ngrok answers for a registered domain even with no tunnel attached, so a
    // bare status code is not proof the app is behind it. The error header is.
    const ngrokError = res.headers.get("ngrok-error-code") ?? undefined;
    if (ngrokError) {
      return { ok: false, detail: `ngrok returned ${ngrokError}`, ngrokError };
    }

    return { ok: res.status < 500, detail: `HTTP ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  /* ---- Claude ---------------------------------------------------- */
  if (!env.anthropicApiKey) {
    add("fail", "ANTHROPIC_API_KEY", "not set - agents cannot think");
  } else {
    try {
      const res = await fetch("https://api.anthropic.com/v1/models?limit=1", {
        headers: {
          "x-api-key": env.anthropicApiKey,
          "anthropic-version": "2023-06-01",
        },
      });
      if (res.ok) add("ok", "ANTHROPIC_API_KEY", "valid");
      else if (res.status === 401)
        add("fail", "ANTHROPIC_API_KEY", "rejected (401) - wrong or revoked key");
      else add("warn", "ANTHROPIC_API_KEY", `unexpected HTTP ${res.status}`);
    } catch (err) {
      add("warn", "ANTHROPIC_API_KEY", `could not verify: ${err}`);
    }
  }

  /* ---- DVIDS -------------------------------------------------------- */
  add(
    env.dvidsApiKey ? "ok" : "warn",
    "DVIDS_API_KEY",
    env.dvidsApiKey
      ? "set - archive footage available"
      : "not set - request one from dvidsservicedesk@dvidshub.net",
  );

  /* ---- SocialCrawl -------------------------------------------------- */
  if (!env.socialCrawlKey) {
    add("warn", "SOCIALCRAWL_API_KEY", "not set - socialcrawl accounts cannot sync");
  } else {
    const usage = db.select().from(apiUsage).all();
    const spent = usage.reduce((n, u) => n + u.credits, 0);
    const balances = usage
      .filter((u) => u.remaining !== null)
      .sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime());
    const left = balances[0]?.remaining ?? null;

    const week = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recent = usage.filter((u) => u.capturedAt.getTime() > week);
    const perWeek = recent.reduce((n, u) => n + u.credits, 0);
    const perMonth = Math.round(perWeek * 4.3);
    const runway =
      left !== null && perMonth > 0 ? ` · ~${(left / (perMonth / 30)).toFixed(0)} days left at this rate` : "";

    add(
      left !== null && left <= env.socialCrawlLowCredits ? "warn" : "ok",
      "SOCIALCRAWL credits",
      `${left ?? "?"} remaining · ${spent} spent so far · ${perWeek} in the last 7d${runway}`,
    );
    add(
      "ok",
      "SOCIALCRAWL cadence",
      `videos every ${env.socialCrawlSyncDays}d (${env.socialCrawlPages} page cap), followers every ${env.socialCrawlFollowerDays}d`,
    );
  }

  /* ---- Database + accounts --------------------------------------- */
  const rows = db.select().from(accounts).all();
  add(
    rows.length > 0 ? "ok" : "fail",
    "database",
    rows.length > 0 ? `${rows.length} account(s)` : 'empty - run "npm run db:seed"',
  );

  console.log("\n  Preflight\n  " + "-".repeat(64));
  for (const r of results) {
    const mark = r.status === "ok" ? "PASS" : r.status === "warn" ? "WARN" : "FAIL";
    console.log(`  [${mark}] ${r.label.padEnd(22)} ${r.detail}`);
  }

  /* ---- Per-account connection state ------------------------------ */
  console.log("\n  Accounts\n  " + "-".repeat(64));
  for (const a of rows) {
    const agent = db.select().from(agents).where(eq(agents.accountId, a.id)).get();
    console.log(`  @${a.handle}  (${a.id})`);
    console.log(
      `    agent     ${agent?.name ?? "none"} - ${agent?.status ?? "-"}`,
    );
    console.log();
  }

  const failures = results.filter((r) => r.status === "fail").length;
  console.log(
    failures === 0
      ? "  Ready to connect accounts.\n"
      : `  ${failures} blocking issue(s) above must be fixed first.\n`,
  );

  process.exit(failures > 0 ? 1 : 0);
}

void main();
