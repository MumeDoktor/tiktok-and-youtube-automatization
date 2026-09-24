import { desc, eq, sql } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "@/db";
import { accounts, contentProfiles, marketInsights, posts } from "@/db/schema";
import { anthropic } from "@/lib/anthropic";
import { MODELS } from "@/lib/env";
import { zonedParts } from "@/lib/tz";
import { logEvent } from "./events";

/* ------------------------------------------------------------------ */
/* Deterministic stats - computed from stored data, no model involved   */
/* ------------------------------------------------------------------ */

export type VideoRow = {
  id: string;
  caption: string;
  hashtags: string[];
  publishedAt: Date | null;
  durationSec: number | null;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  url: string | null;
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Every stored video with its latest metrics. */
export function loadVideos(accountId: string): VideoRow[] {
  const rows = db.all<{
    id: string;
    caption: string;
    hashtags: string;
    published_at: number | null;
    duration_sec: number | null;
    share_url: string | null;
    views: number;
    likes: number;
    comments: number;
    shares: number;
    saves: number;
  }>(sql`
    SELECT p.id, p.caption, p.hashtags, p.published_at, p.duration_sec, p.share_url,
           latest.views, latest.likes, latest.comments, latest.shares, latest.saves
    FROM posts p
    JOIN (
      SELECT m.post_id, m.views, m.likes, m.comments, m.shares, m.saves
      FROM post_metrics m
      JOIN (
        SELECT post_id, MAX(captured_at) AS captured_at
        FROM post_metrics GROUP BY post_id
      ) newest ON newest.post_id = m.post_id AND newest.captured_at = m.captured_at
      GROUP BY m.post_id
    ) latest ON latest.post_id = p.id
    WHERE p.account_id = ${accountId}
  `);

  return rows.map((r) => ({
    id: r.id,
    caption: r.caption,
    hashtags: (() => {
      try {
        const parsed = JSON.parse(r.hashtags);
        return Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        return [];
      }
    })(),
    publishedAt: r.published_at ? new Date(r.published_at * 1000) : null,
    durationSec: r.duration_sec,
    views: r.views,
    likes: r.likes,
    comments: r.comments,
    shares: r.shares,
    saves: r.saves,
    url: r.share_url,
  }));
}

export type HardStats = ReturnType<typeof computeStats>;

/**
 * Everything measurable, derived arithmetically rather than guessed. The model
 * gets these as facts so it never has to estimate a number it can be given.
 */
export function computeStats(videos: VideoRow[], timezone: string) {
  const withDates = videos.filter((v) => v.publishedAt);
  const views = videos.map((v) => v.views);

  const dated = [...withDates].sort(
    (a, b) => a.publishedAt!.getTime() - b.publishedAt!.getTime(),
  );
  const first = dated[0]?.publishedAt ?? null;
  const last = dated[dated.length - 1]?.publishedAt ?? null;
  const spanDays =
    first && last ? Math.max(1, (last.getTime() - first.getTime()) / 86_400_000) : 0;

  // Posting windows measured in the account's own timezone.
  const byHour = new Map<number, number[]>();
  const byDay = new Map<number, number[]>();
  for (const v of withDates) {
    const p = zonedParts(v.publishedAt!, timezone);
    if (!byHour.has(p.hour)) byHour.set(p.hour, []);
    if (!byDay.has(p.dayOfWeek)) byDay.set(p.dayOfWeek, []);
    byHour.get(p.hour)!.push(v.views);
    byDay.get(p.dayOfWeek)!.push(v.views);
  }

  const hourStats = [...byHour.entries()]
    .map(([hour, vs]) => ({ hour, n: vs.length, medianViews: median(vs) }))
    .filter((h) => h.n >= 2)
    .sort((a, b) => b.medianViews - a.medianViews);

  const dayStats = [...byDay.entries()]
    .map(([day, vs]) => ({ day, n: vs.length, medianViews: median(vs) }))
    .filter((d) => d.n >= 2)
    .sort((a, b) => b.medianViews - a.medianViews);

  // Hashtag performance, only where there is enough evidence to mean anything.
  const tagMap = new Map<string, number[]>();
  for (const v of videos) {
    for (const tag of new Set(v.hashtags.map((t) => t.toLowerCase()))) {
      if (!tagMap.has(tag)) tagMap.set(tag, []);
      tagMap.get(tag)!.push(v.views);
    }
  }
  const hashtagStats = [...tagMap.entries()]
    .map(([tag, vs]) => ({ tag, n: vs.length, medianViews: median(vs) }))
    .filter((t) => t.n >= 3)
    .sort((a, b) => b.medianViews - a.medianViews)
    .slice(0, 15);

  // Duration buckets.
  const buckets = [
    { label: "0-15s", min: 0, max: 15 },
    { label: "15-30s", min: 15, max: 30 },
    { label: "30-45s", min: 30, max: 45 },
    { label: "45-60s", min: 45, max: 60 },
    { label: "60s+", min: 60, max: Infinity },
  ];
  const durationStats = buckets
    .map((b) => {
      const vs = videos
        .filter((v) => v.durationSec !== null && v.durationSec >= b.min && v.durationSec < b.max)
        .map((v) => v.views);
      return { ...b, n: vs.length, medianViews: median(vs) };
    })
    .filter((b) => b.n > 0);

  // Recent trend: newest ten against the ten before them.
  const newestFirst = [...withDates].sort(
    (a, b) => b.publishedAt!.getTime() - a.publishedAt!.getTime(),
  );
  const recent10 = median(newestFirst.slice(0, 10).map((v) => v.views));
  const previous10 = median(newestFirst.slice(10, 20).map((v) => v.views));

  const totalViews = views.reduce((a, b) => a + b, 0);
  const totalEngagement = videos.reduce(
    (n, v) => n + v.likes + v.comments + v.shares + v.saves,
    0,
  );

  return {
    videoCount: videos.length,
    firstPost: first,
    lastPost: last,
    postsPerWeek: spanDays > 0 ? Number(((withDates.length / spanDays) * 7).toFixed(1)) : 0,
    totalViews,
    medianViews: median(views),
    bestViews: Math.max(0, ...views),
    worstViews: views.length ? Math.min(...views) : 0,
    engagementRate: totalViews > 0 ? Number(((totalEngagement / totalViews) * 100).toFixed(2)) : 0,
    recent10MedianViews: recent10,
    previous10MedianViews: previous10,
    trendPct:
      previous10 > 0 ? Number((((recent10 - previous10) / previous10) * 100).toFixed(1)) : null,
    bestHours: hourStats.slice(0, 6),
    worstHours: hourStats.slice(-3).reverse(),
    bestDays: dayStats,
    hashtagStats,
    durationStats,
  };
}

/* ------------------------------------------------------------------ */
/* Model pass - qualitative reading of the account                     */
/* ------------------------------------------------------------------ */

const PROFILE_TOOL: Anthropic.Tool = {
  name: "record_account_read",
  description:
    "Record what this account is, what its format is, and what the numbers say about it.",
  input_schema: {
    type: "object",
    properties: {
      niche: {
        type: "string",
        description:
          "One specific line naming the subject matter and who it is for, e.g. 'military aviation history for US men 25-45'. No hedging.",
      },
      formatDescription: {
        type: "string",
        description:
          "What a typical video on this account actually is, described as if briefing an editor. 2-4 sentences.",
      },
      toneOfVoice: { type: "string", description: "Short phrase." },
      hookStyles: {
        type: "array",
        items: { type: "string" },
        description: "3-6 hook patterns visible in the captions that perform well.",
      },
      hashtagStrategy: { type: "string" },
      summary: {
        type: "string",
        description:
          "4-8 sentences: what is working, what is not, and what the numbers actually show. Cite specific figures given to you. Lead with the most important finding.",
      },
      whatWorks: {
        type: "array",
        items: { type: "string" },
        description: "Concrete patterns behind the best performers, each tied to evidence.",
      },
      whatToFix: {
        type: "array",
        items: { type: "string" },
        description: "Specific, actionable changes ranked by expected impact.",
      },
      topicIdeas: {
        type: "array",
        description: "5 next videos that fit the established format.",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            hook: { type: "string" },
            why: { type: "string" },
          },
          required: ["title", "hook", "why"],
          additionalProperties: false,
        },
      },
    },
    required: [
      "niche",
      "formatDescription",
      "toneOfVoice",
      "hookStyles",
      "hashtagStrategy",
      "summary",
      "whatWorks",
      "whatToFix",
      "topicIdeas",
    ],
    additionalProperties: false,
  },
};

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function renderStats(stats: HardStats, timezone: string): string {
  const lines: string[] = [
    `Videos analysed: ${stats.videoCount}`,
    `Posting since: ${stats.firstPost?.toISOString().slice(0, 10) ?? "unknown"}`,
    `Most recent post: ${stats.lastPost?.toISOString().slice(0, 10) ?? "unknown"}`,
    `Posting rate: ${stats.postsPerWeek} videos/week`,
    `Total views: ${stats.totalViews.toLocaleString()}`,
    `Median views: ${stats.medianViews.toLocaleString()}  (best ${stats.bestViews.toLocaleString()}, worst ${stats.worstViews.toLocaleString()})`,
    `Engagement rate: ${stats.engagementRate}% of views`,
    `Recent 10 median: ${stats.recent10MedianViews.toLocaleString()} vs previous 10: ${stats.previous10MedianViews.toLocaleString()}` +
      (stats.trendPct !== null ? ` (${stats.trendPct > 0 ? "+" : ""}${stats.trendPct}%)` : ""),
    "",
    `Posting hours by median views (${timezone}, only hours with 2+ posts):`,
    ...stats.bestHours.map(
      (h) => `  ${String(h.hour).padStart(2, "0")}:00 - ${h.medianViews.toLocaleString()} median (n=${h.n})`,
    ),
    "",
    "Days by median views:",
    ...stats.bestDays.map(
      (d) => `  ${DAYS[d.day]} - ${d.medianViews.toLocaleString()} median (n=${d.n})`,
    ),
    "",
    "Duration vs median views:",
    ...stats.durationStats.map(
      (d) => `  ${d.label} - ${d.medianViews.toLocaleString()} median (n=${d.n})`,
    ),
  ];

  if (stats.hashtagStats.length) {
    lines.push("", "Hashtags with 3+ uses, by median views:");
    for (const t of stats.hashtagStats) {
      lines.push(`  #${t.tag} - ${t.medianViews.toLocaleString()} median (n=${t.n})`);
    }
  }
  return lines.join("\n");
}

/**
 * Reads the account from its own data and writes the result back as the
 * niche, the content profile, and a stored analysis.
 *
 * This is what makes the dashboard self-configuring: nothing here asks the
 * owner what the account is about, because the videos already say.
 */
export async function analyzeAccount(accountId: string) {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) throw new Error(`No account ${accountId}`);

  const videos = loadVideos(accountId);
  if (videos.length === 0) {
    throw new Error("No videos stored yet - run a sync first.");
  }

  const stats = computeStats(videos, account.timezone);

  // Give the model the best and worst performers rather than all 98, so the
  // contrast between them is what it reasons about.
  const byViews = [...videos].sort((a, b) => b.views - a.views);
  const sample = (list: VideoRow[]) =>
    list.map(
      (v) =>
        `  ${v.views.toLocaleString().padStart(9)} views | ${v.likes.toLocaleString().padStart(7)} likes | ` +
        `${v.saves.toLocaleString().padStart(6)} saves | ${v.durationSec ? `${Math.round(v.durationSec)}s` : "?"} | ` +
        `${v.publishedAt?.toISOString().slice(0, 10) ?? "?"} | ${v.caption.slice(0, 110)}`,
    );

  const response = await anthropic().messages.create({
    model: MODELS.strategy,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    system:
      "You analyse a single TikTok account from its own performance data and say what it is and what the numbers show. " +
      "Every number you state must come from the data given to you - never estimate or invent one. " +
      "Be specific and blunt. The owner is short on time and wants the real read, not encouragement.",
    messages: [
      {
        role: "user",
        content: [
          `Account: @${account.handle}${account.displayName ? ` (${account.displayName})` : ""}`,
          `Timezone: ${account.timezone}`,
          "",
          "MEASURED STATISTICS",
          renderStats(stats, account.timezone),
          "",
          `TOP 20 VIDEOS BY VIEWS`,
          ...sample(byViews.slice(0, 20)),
          "",
          `BOTTOM 15 VIDEOS BY VIEWS`,
          ...sample(byViews.slice(-15)),
          "",
          "Work out what this account is, what its format is, what separates the winners from the losers, and what to do next.",
        ].join("\n"),
      },
    ],
    tools: [PROFILE_TOOL],
    tool_choice: { type: "tool", name: "record_account_read" },
  });

  const block = response.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error("Analysis returned no structured result");
  }

  const read = block.input as {
    niche: string;
    formatDescription: string;
    toneOfVoice: string;
    hookStyles: string[];
    hashtagStrategy: string;
    summary: string;
    whatWorks: string[];
    whatToFix: string[];
    topicIdeas: Array<{ title: string; hook: string; why: string }>;
  };

  // Fill in the account setup from what the data said.
  db.update(accounts).set({ niche: read.niche }).where(eq(accounts.id, accountId)).run();

  const existingProfile = db
    .select()
    .from(contentProfiles)
    .where(eq(contentProfiles.accountId, accountId))
    .get();

  const profileFields = {
    description: read.formatDescription,
    toneOfVoice: read.toneOfVoice,
    hookStyles: JSON.stringify(read.hookStyles),
    hashtagStrategy: read.hashtagStrategy,
    updatedAt: new Date(),
  };

  if (existingProfile) {
    db.update(contentProfiles)
      .set(profileFields)
      .where(eq(contentProfiles.accountId, accountId))
      .run();
  } else {
    db.insert(contentProfiles).values({ accountId, ...profileFields }).run();
  }

  // Posting windows come from measured medians, not from the model.
  const bestPostTimes = stats.bestHours.slice(0, 4).flatMap((h) =>
    stats.bestDays.slice(0, 3).map((d) => ({
      dayOfWeek: d.day,
      hourLocal: h.hour,
      score: Number((h.medianViews / (stats.bestHours[0]?.medianViews || 1)).toFixed(2)),
      why: `${DAYS[d.day]} ${h.hour}:00 - median ${h.medianViews.toLocaleString()} views across ${h.n} posts`,
    })),
  );

  const insight = db
    .insert(marketInsights)
    .values({
      accountId,
      summary: read.summary,
      trendingHashtags: JSON.stringify(
        stats.hashtagStats.slice(0, 8).map((t) => ({
          hashtag: `#${t.tag}`,
          why: `median ${t.medianViews.toLocaleString()} views over ${t.n} posts`,
        })),
      ),
      topicIdeas: JSON.stringify(read.topicIdeas),
      bestPostTimes: JSON.stringify(bestPostTimes),
      rawAnalysis: JSON.stringify({ read, stats }, null, 2),
    })
    .returning()
    .get();

  logEvent({
    accountId,
    level: "success",
    type: "analysis.done",
    message: `Analysed ${videos.length} videos: ${read.niche}`,
  });

  return { read, stats, insight };
}

/** Most recent stored analysis, if any. */
export function latestAnalysis(accountId: string) {
  return db
    .select()
    .from(marketInsights)
    .where(eq(marketInsights.accountId, accountId))
    .orderBy(desc(marketInsights.capturedAt))
    .limit(1)
    .get();
}
