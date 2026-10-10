import { and, desc, eq, gte, inArray, lte, or } from "drizzle-orm";
import { db } from "@/db";
import {
  accounts,
  agentEvents,
  agents,
  contentProfiles,
  marketInsights,
  clips,
  jobs,
  metricSnapshots,
  postMetrics,
  posts,
  type Account,
} from "@/db/schema";
import { readAeOutcome } from "@/lib/ae-editor";
import { env } from "@/lib/env";
import {
  accountWindows,
  fixedSlots,
  formatSlot,
  hourLabel,
  pendingAutopilotJob,
  readAutopilotPayload,
  windowLabel,
} from "@/agent/autopilot";

export type AutopilotView = {
  enabled: boolean;
  perWeek: number;
  /** Posting at AUTOPILOT_SLOTS every day, rather than at measured best hours. */
  fixed: boolean;
  /** Finished videos are posted through the phone, not by you. */
  postsFromPhone: boolean;
  leadMinutes: number;
  timezone: string;
  /** The measured hour the windows sit on, e.g. "7 PM posts get a median ...". */
  evidence: string | null;
  windows: Array<{ label: string; why: string }>;
  /** Why nothing can be planned, when nothing can. */
  blocked: string | null;
  next: { slot: string; starts: string; running: boolean } | null;
};

function autopilotView(account: Account): AutopilotView {
  const { windows, blocked } = accountWindows(account);
  const job = pendingAutopilotJob(account.id);
  const payload = job ? readAutopilotPayload(job) : null;
  const fixed = fixedSlots();

  return {
    enabled: account.autopilot,
    perWeek: fixed ? env.autopilotSlots.length * 7 : env.autopilotPerWeek,
    fixed,
    postsFromPhone: env.phonePublish,
    leadMinutes: env.autopilotLeadMinutes,
    timezone: account.timezone,
    evidence: fixed ? null : (windows[0]?.hourWhy ?? null),
    windows: fixed
      ? env.autopilotSlots.map((s) => ({
          label: `Daily ${hourLabel(s.hour, s.minute)}`,
          why: "Fixed time (AUTOPILOT_SLOTS)",
        }))
      : windows.map((w) => ({ label: windowLabel(w), why: w.dayWhy })),
    blocked: account.status !== "active" ? "The account is paused." : blocked,
    next:
      job && payload
        ? {
            slot: formatSlot(new Date(payload.slotAt), account.timezone),
            starts: formatSlot(job.runAt, account.timezone),
            running: job.status === "running",
          }
        : null,
  };
}

export type AccountSummary = {
  id: string;
  handle: string;
  displayName: string;
  niche: string;
  status: string;
  timezone: string;
  agentName: string | null;
  agentStatus: string | null;
  lastRunAt: Date | null;
  followers: number;
  totalViews: number;
  likes: number;
  videoCount: number;
  followersDelta7d: number | null;
  viewsDelta7d: number | null;
  likesDelta7d: number | null;
  series: Array<{ t: number; v: number }>;
};

const DAY = 24 * 60 * 60 * 1000;

function pctChange(now: number, before: number | undefined): number | null {
  if (before === undefined || before === 0) return null;
  return ((now - before) / before) * 100;
}

export function getAccountSummaries(): AccountSummary[] {
  const rows = db.select().from(accounts).orderBy(accounts.createdAt).all();

  return rows.map((a) => {
    const agent = db.select().from(agents).where(eq(agents.accountId, a.id)).get();

    const snaps = db
      .select()
      .from(metricSnapshots)
      .where(
        and(
          eq(metricSnapshots.accountId, a.id),
          gte(metricSnapshots.capturedAt, new Date(Date.now() - 30 * DAY)),
        ),
      )
      .orderBy(metricSnapshots.capturedAt)
      .all();

    const latest = snaps[snaps.length - 1];
    // Nearest snapshot at or before the 7-day mark.
    const weekAgoTs = Date.now() - 7 * DAY;
    const weekAgo = [...snaps].reverse().find((s) => s.capturedAt.getTime() <= weekAgoTs);

    return {
      id: a.id,
      handle: a.handle,
      displayName: a.displayName,
      niche: a.niche,
      status: a.status,
      timezone: a.timezone,
      agentName: agent?.name ?? null,
      agentStatus: agent?.status ?? null,
      lastRunAt: agent?.lastRunAt ?? null,
      followers: latest?.followers ?? 0,
      totalViews: latest?.totalViews ?? 0,
      likes: latest?.likes ?? 0,
      videoCount: latest?.videoCount ?? 0,
      followersDelta7d: latest ? pctChange(latest.followers, weekAgo?.followers) : null,
      viewsDelta7d: latest ? pctChange(latest.totalViews, weekAgo?.totalViews) : null,
      likesDelta7d: latest ? pctChange(latest.likes, weekAgo?.likes) : null,
      series: snaps.map((s) => ({ t: s.capturedAt.getTime(), v: s.followers })),
    };
  });
}

export function getAccountDetail(accountId: string) {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) return null;

  const agent = db.select().from(agents).where(eq(agents.accountId, accountId)).get();
  const profile = db
    .select()
    .from(contentProfiles)
    .where(eq(contentProfiles.accountId, accountId))
    .get();

  const snaps = db
    .select()
    .from(metricSnapshots)
    .where(
      and(
        eq(metricSnapshots.accountId, accountId),
        gte(metricSnapshots.capturedAt, new Date(Date.now() - 30 * DAY)),
      ),
    )
    .orderBy(metricSnapshots.capturedAt)
    .all();

  const postRows = db
    .select()
    .from(posts)
    .where(eq(posts.accountId, accountId))
    .orderBy(desc(posts.createdAt))
    .limit(200)
    .all();

  const postsWithStats = postRows.map((p) => {
    const m = db
      .select()
      .from(postMetrics)
      .where(eq(postMetrics.postId, p.id))
      .orderBy(desc(postMetrics.capturedAt))
      .limit(1)
      .get();
    return {
      ...p,
      views: m?.views ?? 0,
      likesCount: m?.likes ?? 0,
      comments: m?.comments ?? 0,
      shares: m?.shares ?? 0,
      saves: m?.saves ?? 0,
    };
  });

  const insight = db
    .select()
    .from(marketInsights)
    .where(eq(marketInsights.accountId, accountId))
    .orderBy(desc(marketInsights.capturedAt))
    .limit(1)
    .get();

  const events = db
    .select()
    .from(agentEvents)
    .where(eq(agentEvents.accountId, accountId))
    .orderBy(desc(agentEvents.createdAt))
    .limit(20)
    .all();

  // The stored analysis carries the model's qualitative read plus the measured
  // statistics it was derived from.
  let analysis: {
    read?: {
      niche: string;
      formatDescription: string;
      toneOfVoice: string;
      summary: string;
      whatWorks: string[];
      whatToFix: string[];
      topicIdeas: Array<{ title: string; hook: string; why: string }>;
    };
    stats?: Record<string, unknown>;
  } | null = null;

  if (insight?.rawAnalysis) {
    try {
      analysis = JSON.parse(insight.rawAnalysis);
    } catch {
      analysis = null;
    }
  }

  const clipRows = db
    .select()
    .from(clips)
    .where(eq(clips.accountId, accountId))
    .orderBy(desc(clips.createdAt))
    .limit(20)
    .all()
    .map((c) => ({
      ...c,
      hashtags: (() => {
        try {
          const p = JSON.parse(c.hashtags);
          return Array.isArray(p) ? p.map(String) : [];
        } catch {
          return [];
        }
      })(),
      progress: (() => {
        try {
          const p = JSON.parse(c.progress);
          return Array.isArray(p) ? (p as Array<{ at: number; message: string }>) : [];
        } catch {
          return [];
        }
      })(),
      createdAt: c.createdAt.getTime(),
      scheduledFor: c.scheduledFor?.getTime() ?? null,
      scheduledLabel: c.scheduledFor ? formatSlot(c.scheduledFor, account.timezone) : null,
      // Read from the editor's run folder, and only while the edit waits on a person.
      ae: (() => {
        if (c.status !== "review_in_ae") return null;
        const outcome = readAeOutcome(c.id);
        return outcome?.status === "built"
          ? { comp: outcome.comp, aep: outcome.aep, exportDir: outcome.exportDir }
          : null;
      })(),
    }));

  // Videos asked for that have no clip row yet: a job the worker has not picked
  // up, or an interview hunt still searching. Without these the list sits empty
  // after the button is pressed, which reads as nothing having happened.
  const now = Date.now();
  const starting = db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.accountId, accountId),
        inArray(jobs.type, ["produce", "find_source", "autopilot"]),
        or(
          and(eq(jobs.status, "queued"), lte(jobs.runAt, new Date(now))),
          and(eq(jobs.type, "find_source"), eq(jobs.status, "running")),
        ),
      ),
    )
    .orderBy(desc(jobs.createdAt))
    .all()
    .map((j) => ({
      id: j.id,
      type: j.type,
      status: j.status,
      // The worker polls every few seconds, so a minute unclaimed means it is not running.
      stalled: j.status === "queued" && now - j.runAt.getTime() > 60_000,
    }));

  const latest = snaps[snaps.length - 1];
  const weekAgoTs = Date.now() - 7 * DAY;
  const weekAgo = [...snaps].reverse().find((s) => s.capturedAt.getTime() <= weekAgoTs);

  const videos = [...postsWithStats].sort((a, b) => b.views - a.views);

  return {
    account,
    agent,
    profile,
    snaps,
    videos,
    clips: clipRows,
    starting,
    autopilot: autopilotView(account),
    latest,
    deltas: {
      followers: latest ? pctChange(latest.followers, weekAgo?.followers) : null,
      views: latest ? pctChange(latest.totalViews, weekAgo?.totalViews) : null,
      likes: latest ? pctChange(latest.likes, weekAgo?.likes) : null,
      videos: latest ? pctChange(latest.videoCount, weekAgo?.videoCount) : null,
    },
    posts: postsWithStats,
    insight,
    analysis,
    events,
  };
}

export type AccountDetail = NonNullable<ReturnType<typeof getAccountDetail>>;
