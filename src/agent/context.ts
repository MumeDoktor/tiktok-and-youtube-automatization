import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  accounts,
  agentMemory,
  agents,
  contentProfiles,
  clips,
  marketInsights,
  metricSnapshots,
  postMetrics,
  posts,
  type Account,
  type Agent,
  type AgentMemory,
  type ContentProfile,
  type Clip,
  type MarketInsight,
  type MetricSnapshot,
} from "@/db/schema";

export type PostWithStats = {
  id: string;
  caption: string;
  hashtags: string[];
  publishedAt: Date | null;
  views: number;
  likes: number;
  comments: number;
  shares: number;
};

export type AgentContext = {
  account: Account;
  agent: Agent | undefined;
  profile: ContentProfile | undefined;
  memory: AgentMemory[];
  latest: MetricSnapshot | undefined;
  previous: MetricSnapshot | undefined;
  recentPosts: PostWithStats[];
  recentClips: Clip[];
  insight: MarketInsight | undefined;
};

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Everything an agent needs to know about its account, in one query batch. */
export async function buildAgentContext(accountId: string): Promise<AgentContext> {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) throw new Error(`No account ${accountId}`);

  const agent = db.select().from(agents).where(eq(agents.accountId, accountId)).get();

  const profile = db
    .select()
    .from(contentProfiles)
    .where(eq(contentProfiles.accountId, accountId))
    .get();

  const memory = db
    .select()
    .from(agentMemory)
    .where(and(eq(agentMemory.accountId, accountId), eq(agentMemory.active, true)))
    .orderBy(desc(agentMemory.createdAt))
    .all();

  const snaps = db
    .select()
    .from(metricSnapshots)
    .where(eq(metricSnapshots.accountId, accountId))
    .orderBy(desc(metricSnapshots.capturedAt))
    .limit(2)
    .all();

  const insight = db
    .select()
    .from(marketInsights)
    .where(eq(marketInsights.accountId, accountId))
    .orderBy(desc(marketInsights.capturedAt))
    .limit(1)
    .get();

  // Order by publish date, not insert date: every video was inserted in the
  // same batch, so createdAt says nothing about which posts are recent.
  const recent = db
    .select()
    .from(posts)
    .where(eq(posts.accountId, accountId))
    .orderBy(desc(posts.publishedAt))
    .limit(15)
    .all();

  const recentPosts: PostWithStats[] = recent.map((p) => {
    const m = db
      .select()
      .from(postMetrics)
      .where(eq(postMetrics.postId, p.id))
      .orderBy(desc(postMetrics.capturedAt))
      .limit(1)
      .get();
    return {
      id: p.id,
      caption: p.caption,
      hashtags: parseJsonArray(p.hashtags),
      publishedAt: p.publishedAt,
      views: m?.views ?? 0,
      likes: m?.likes ?? 0,
      comments: m?.comments ?? 0,
      shares: m?.shares ?? 0,
    };
  });

  const recentClips = db
    .select()
    .from(clips)
    .where(eq(clips.accountId, accountId))
    .orderBy(desc(clips.createdAt))
    .limit(8)
    .all();

  return {
    account,
    agent,
    profile,
    memory,
    recentClips,
    latest: snaps[0],
    previous: snaps[1],
    recentPosts,
    insight,
  };
}

/* ------------------------------------------------------------------ */
/* Prompt rendering                                                    */
/* ------------------------------------------------------------------ */

/**
 * The stable half of the system prompt: identity, rules, content profile,
 * standing directives. Changes only when you change the account setup or
 * the agent learns something durable, so it caches well across turns.
 */
export function renderStablePrompt(ctx: AgentContext): string {
  const { account, agent, profile, memory } = ctx;
  const lines: string[] = [];

  lines.push(
    `You are ${agent?.name ?? "the agent"}, the autonomous TikTok manager for a single account.`,
    `You do not manage any other account. Everything below is about @${account.handle}.`,
    "",
    "## Account",
    `- Handle: @${account.handle}`,
    `- Display name: ${account.displayName}`,
    `- Niche: ${account.niche || "(not set)"}`,
    `- Target audience: ${account.targetCountry} viewers`,
    `- Account timezone for scheduling: ${account.timezone}`,
    "",
  );

  if (profile) {
    const hooks = parseJsonArray(profile.hookStyles);
    const donts = parseJsonArray(profile.doNotDo);

    lines.push(
      "## Content profile (derived from this account's own videos)",
      `- What this account posts: ${profile.description || "(not set)"}`,
      `- Tone of voice: ${profile.toneOfVoice || "(not set)"}`,
      `- Hashtag strategy: ${profile.hashtagStrategy || "(none)"}`,
    );
    if (hooks.length) lines.push(`- Hook styles that work: ${hooks.join(" | ")}`);
    if (donts.length) {
      lines.push("- Hard rules (never violate):");
      for (const d of donts) lines.push(`  - ${d}`);
    }
    lines.push("");
  }

  if (memory.length) {
    lines.push(
      "## Standing memory",
      "Things the owner told you in past conversations, or that you learned from results.",
      "These outrank your own preferences and persist across every session.",
    );
    for (const m of memory) {
      lines.push(`- [${m.kind}] ${m.content}`);
    }
    lines.push("");
  }

  if (agent?.persona) {
    lines.push("## Persona", agent.persona, "");
  }

  lines.push(
    "## Operating rules",
    "1. When you state a number, take it from the data given to you. If you do not have it, say you do not have it. Never estimate a figure you were not given.",
    "2. Optimize for what the account's own numbers show, not for generic advice.",
    "3. Be concise and direct with the owner. They are short on time. Lead with the answer.",
  );

  return lines.join("\n");
}

function pct(now: number, before: number | undefined): string {
  if (before === undefined || before === 0) return "";
  const d = ((now - before) / before) * 100;
  const sign = d >= 0 ? "+" : "";
  return ` (${sign}${d.toFixed(1)}% vs previous snapshot)`;
}

/**
 * The volatile half: live numbers, recent post performance, latest market read.
 * Kept after the stable block so it never invalidates the cached prefix.
 */
export function renderLivePrompt(ctx: AgentContext): string {
  const { latest, previous, recentPosts, insight } = ctx;
  const lines: string[] = ["## Live account data"];

  if (latest) {
    lines.push(
      `As of ${latest.capturedAt.toISOString()}:`,
      `- Followers: ${latest.followers.toLocaleString()}${pct(latest.followers, previous?.followers)}`,
      `- Total likes: ${latest.likes.toLocaleString()}${pct(latest.likes, previous?.likes)}`,
      `- Total views: ${latest.totalViews.toLocaleString()}${pct(latest.totalViews, previous?.totalViews)}`,
      `- Videos published: ${latest.videoCount}`,
    );
  } else {
    lines.push("No metrics captured yet - the account is not connected to TikTok, or the first sync has not run.");
  }
  lines.push("");

  if (recentPosts.length) {
    lines.push("## Recent posts (newest first)");
    for (const p of recentPosts) {
      const when = p.publishedAt ? p.publishedAt.toISOString().slice(0, 16) : "date unknown";
      const caption = p.caption.length > 70 ? `${p.caption.slice(0, 70)}...` : p.caption;
      lines.push(
        `- ${when} | ${p.views.toLocaleString()} views, ${p.likes.toLocaleString()} likes, ${p.comments} comments, ${p.shares} shares | "${caption}"`,
      );
    }
    lines.push("");
  }

  if (insight) {
    lines.push(
      `## Latest market read (${insight.capturedAt.toISOString().slice(0, 16)})`,
      insight.summary,
      "",
    );
    const times = insight.bestPostTimes;
    if (times && times !== "[]") lines.push(`Best posting windows (JSON): ${times}`, "");
    const tags = insight.trendingHashtags;
    if (tags && tags !== "[]") lines.push(`Trending hashtags (JSON): ${tags}`, "");
  } else {
    lines.push("## Latest market read", "None yet - market analysis has not run for this account.", "");
  }

  if (ctx.recentClips.length) {
    lines.push("## Clips you produced (newest first)");
    for (const c of ctx.recentClips) {
      lines.push(
        `- [${c.status}] ${c.hookText || c.sourceUrl}` +
          (c.outputDurationSec ? ` (${Math.round(c.outputDurationSec)}s)` : ""),
      );
      if (c.rationale) {
        // Collapse the multi-line rationale onto one line for the prompt.
        lines.push(`  reasoning: ${c.rationale.replace(/\s+/g, " ").slice(0, 300)}`);
      }
    }
    lines.push("");
  }

  lines.push(`Current time: ${new Date().toISOString()} (UTC)`);

  return lines.join("\n");
}
