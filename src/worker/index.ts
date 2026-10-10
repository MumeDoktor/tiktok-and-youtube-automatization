/**
 * The background loop. Run alongside the dashboard:
 *
 *   npm run worker
 *
 * Two responsibilities:
 *   1. Scheduler - decides when each account is due a sync.
 *   2. Runner    - claims due jobs one at a time and executes them.
 */
// MUST stay first: populates process.env before the modules below read it.
import "./load-env";

import { and, asc, eq, lte } from "drizzle-orm";
import { db } from "../db/index";
import { accounts, jobs, settings } from "../db/schema";
import { env } from "../lib/env";
import { enqueue, logEvent } from "../agent/events";
import { syncAccount, maybeAnalyse } from "../agent/sync";
import { makeClip } from "../agent/clip";
import { makeDvidsClip } from "../agent/footage";
import { produceForSlot, produceNext, producePodcastClips, reportProduced } from "../agent/produce";
import { collectAeExports, editInAe, exportInAe, type AeEditPayload } from "../agent/ae-edit";
import { editInCodex, type CodexEditPayload } from "../agent/codex-edit";
import { fixedSlots, hourLabel, planAutopilot, readAutopilotPayload } from "../agent/autopilot";
import { publishClip, reportPublishGaveUp, type PublishPayload } from "../agent/publish";
import { handoffClipToClaude } from "../lib/claude-handoff";
import { makeVideo } from "../agent/make";
import { makeLongVideo } from "../agent/long";
import { aeEditorDir, useAeEditor } from "../lib/ae-editor";
import { pollTelegram, telegramStatus } from "../agent/telegram-review";
import { reviseInAe, type RevisePayload } from "../agent/revise";
import { checkComments, checkCommentsBeforeVideo, sendReplies } from "../agent/comments";

type JobRow = typeof jobs.$inferSelect;

const HOUR = 60 * 60 * 1000;

function lastRun(key: string): number {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  return row ? Number(row.value) : 0;
}

function markRun(key: string, at = Date.now()) {
  const existing = db.select().from(settings).where(eq(settings.key, key)).get();
  if (existing) {
    db.update(settings).set({ value: String(at) }).where(eq(settings.key, key)).run();
  } else {
    db.insert(settings).values({ key, value: String(at) }).run();
  }
}

function schedule() {
  const active = db.select().from(accounts).where(eq(accounts.status, "active")).all();

  for (const account of active) {
    // Each sync costs credits, so a tighter loop buys very little extra signal.
    const key = `sched:sync:${account.id}`;
    const every = Math.max(1, env.socialCrawlSyncDays) * 24 * HOUR;
    if (Date.now() - lastRun(key) > every) {
      enqueue({ accountId: account.id, type: "sync" });
      markRun(key);
    }

    // Off unless asked for: a hunt reads a whole transcript and can render
    // several videos, so it is not something to start spending on by default.
    if (env.podcastHuntDays > 0) {
      const huntKey = `sched:hunt:${account.id}`;
      const huntEvery = env.podcastHuntDays * 24 * HOUR;
      if (Date.now() - lastRun(huntKey) > huntEvery) {
        enqueue({ accountId: account.id, type: "find_source" });
        markRun(huntKey);
      }
    }

    // A no-op unless the account has autopilot on and no slot queued yet.
    planAutopilot(account);
  }
}

async function runJob(job: JobRow) {
  const accountId = job.accountId;
  if (!accountId) throw new Error(`Job ${job.id} has no account`);

  switch (job.type) {
    case "sync":
      await syncAccount(accountId);
      return;
    case "analyze":
      await maybeAnalyse(accountId, 1);
      return;
    case "produce": {
      const { clipId } = await produceNext(accountId);
      reportProduced(accountId, clipId);
      return;
    }
    case "find_source":
      await producePodcastClips(accountId);
      return;
    case "find_footage": {
      const payload = JSON.parse(job.payload) as { clipId?: string };
      if (!payload.clipId) throw new Error(`Job ${job.id} has no clipId`);
      await makeDvidsClip(accountId, payload.clipId);
      return;
    }
    case "make_clip": {
      const payload = JSON.parse(job.payload) as { clipId?: string };
      if (!payload.clipId) throw new Error(`Job ${job.id} has no clipId`);
      await makeClip(accountId, payload.clipId);
      return;
    }
    case "edit_ae":
      await editInAe(accountId, JSON.parse(job.payload) as AeEditPayload);
      return;
    case "revise_ae":
      await reviseInAe(accountId, JSON.parse(job.payload) as RevisePayload);
      return;
    case "edit_codex":
      await editInCodex(accountId, JSON.parse(job.payload) as CodexEditPayload);
      return;
    case "export_ae":
      await exportInAe(accountId, JSON.parse(job.payload) as { clipId: string });
      return;
    case "publish_phone":
      if (env.publishBackend === "claude") {
        await handoffClipToClaude(accountId, (JSON.parse(job.payload) as PublishPayload).clipId);
      } else {
        await publishClip(accountId, JSON.parse(job.payload) as PublishPayload);
      }
      return;
    case "handoff_claude":
      await handoffClipToClaude(accountId, (JSON.parse(job.payload) as PublishPayload).clipId);
      return;
    case "make_video":
      await makeVideo(accountId);
      return;
    case "make_long":
      await makeLongVideo(accountId, JSON.parse(job.payload) as { topic?: string | null; clipId?: string });
      return;
    case "post_now":
      // Always the direct, verified phone driver - an approval means post it
      // now, to the clip's own account, not hand it on.
      await publishClip(accountId, JSON.parse(job.payload) as PublishPayload);
      return;
    case "autopilot": {
      const payload = readAutopilotPayload(job);
      if (!payload) throw new Error(`Job ${job.id} has no slot`);
      // The phone is free until the video is made: read the comments first.
      if (Date.now() < payload.slotAt) await checkCommentsBeforeVideo(accountId);
      await produceForSlot(accountId, payload);
      return;
    }
    case "check_comments":
      await checkComments(accountId);
      return;
    case "reply_comments":
      await sendReplies(accountId);
      return;
    default:
      throw new Error(`Unknown job type ${job.type}`);
  }
}

/** Claims and runs at most one due job. Returns true if it ran something. */
async function tick(): Promise<boolean> {
  const due = and(eq(jobs.status, "queued"), lte(jobs.runAt, new Date()));
  // An approved video jumps the queue: Approve means post it now, not after
  // whatever builds and syncs autopilot queued earlier.
  const job =
    db.select().from(jobs).where(and(due, eq(jobs.type, "post_now"))).orderBy(asc(jobs.runAt)).limit(1).get() ??
    db.select().from(jobs).where(due).orderBy(asc(jobs.runAt)).limit(1).get();

  if (!job) return false;

  db.update(jobs)
    .set({ status: "running", startedAt: new Date(), attempts: job.attempts + 1 })
    .where(eq(jobs.id, job.id))
    .run();

  try {
    await runJob(job);
    db.update(jobs)
      .set({ status: "done", finishedAt: new Date(), lastError: null })
      .where(eq(jobs.id, job.id))
      .run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = job.attempts + 1;
    const giveUp = attempts >= job.maxAttempts;

    db.update(jobs)
      .set({
        status: giveUp ? "failed" : "queued",
        lastError: message,
        finishedAt: giveUp ? new Date() : null,
        // Exponential backoff: 1m, 4m, 9m.
        runAt: giveUp ? job.runAt : new Date(Date.now() + attempts * attempts * 60_000),
      })
      .where(eq(jobs.id, job.id))
      .run();

    const publish = job.type === "publish_phone" || job.type === "handoff_claude" || job.type === "post_now";
    if (giveUp && publish) {
      reportPublishGaveUp(job.accountId, message, job.type === "handoff_claude" || env.publishBackend === "claude");
    }

    logEvent({
      accountId: job.accountId,
      level: giveUp ? "error" : "warn",
      // A post that gave up was just reported above, in its own words.
      ...(giveUp && publish ? { telegram: false } : {}),
      type: `job.${job.type}.${giveUp ? "failed" : "retry"}`,
      message: giveUp
        ? `${job.type} failed after ${attempts} attempts: ${message}`
        : `${job.type} failed (attempt ${attempts}/${job.maxAttempts}), retrying: ${message}`,
    });
  }

  return true;
}

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`\n${sig} received - finishing the current job then exiting.`);
    stopping = true;
  });
}

async function main() {
  console.log("Worker started.");
  console.log(`  poll interval: ${env.workerIntervalMs}ms`);
  console.log(`  sync cadence:  every ${env.socialCrawlSyncDays} day(s)`);
  console.log(
    `  source hunt:   ${env.podcastHuntDays > 0 ? `every ${env.podcastHuntDays} day(s)` : "off (set PODCAST_HUNT_DAYS)"}`,
  );
  const slots = fixedSlots()
    ? `daily at ${env.autopilotSlots.map((s) => hourLabel(s.hour, s.minute)).join(" and ")}`
    : `${env.autopilotPerWeek} video(s)/week at measured best hours`;
  console.log(
    `  autopilot:     ${slots} where switched on, started ${env.autopilotLeadMinutes}min before each slot`,
  );
  console.log(
    `  publishing:    ${env.phonePublish ? env.publishBackend === "claude" ? "handoff to Claude after render" : `phone driver${env.phoneDryRun ? " (DRY RUN - stops before Post)" : ""}` : "off (set PHONE_PUBLISH=on)"}`,
  );
  console.log(`  ae export:     ${env.aeAutoExport ? "automatic" : "after your review"}`);
  console.log(`  claude:        your subscription (paid API ${process.env.PAID_API === "on" ? "ON - bills ANTHROPIC_API_KEY" : "off"})`);
  console.log(`  socialcrawl:   ${env.socialCrawlKey ? "set" : "MISSING"}`);
  console.log(`  editor:        ${env.editorBackend === "codex" ? "Codex audio-first" : useAeEditor() ? `After Effects (${aeEditorDir})` : "Remotion"}`);
  console.log(`  telegram:      ${telegramStatus()}`);
  console.log(
    `  comments:      ${env.commentReplies === "off" || !env.phonePublish ? "off" : `read before each autopilot video, replies ${env.commentReplies === "auto" ? "sent automatically" : "sent after your OK in Telegram"}`}`,
  );

  logEvent({
    type: "worker.started",
    message: `Worker started - videos export ${env.aeAutoExport ? "on their own" : "after a review in After Effects"}, comment replies: ${env.commentReplies}.`,
  });

  // Its own timer, not the job loop: an Approve pressed during a half-hour
  // After Effects build should still be taken within seconds.
  const phone = setInterval(() => void pollTelegram(), 3_000);

  // Recover jobs that were mid-flight when the process last died.
  const stuck = db
    .update(jobs)
    .set({ status: "queued" })
    .where(eq(jobs.status, "running"))
    .run();
  if (stuck.changes > 0) console.log(`  requeued ${stuck.changes} interrupted job(s)`);

  while (!stopping) {
    try {
      schedule();
      let ran = true;
      while (ran && !stopping) ran = await tick();
      // Between jobs, never during one: an export sitting in a clip's folder
      // for another tick costs nothing.
      await collectAeExports();
    } catch (err) {
      console.error("Worker loop error:", err);
    }
    if (stopping) break;
    await new Promise((r) => setTimeout(r, env.workerIntervalMs));
  }

  clearInterval(phone);
  console.log("Worker stopped.");
  process.exit(0);
}

void main();
