import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  accounts,
  apiUsage,
  metricSnapshots,
  postMetrics,
  posts,
  settings,
} from "@/db/schema";
import { env } from "@/lib/env";
import { fetchFollowerCount, fetchProfileVideos, onUsage } from "@/lib/socialcrawl";
import type { ProviderProfile } from "@/lib/social";
import { analyzeAccount, latestAnalysis } from "./account-analysis";
import { logEvent } from "./events";

function putSetting(key: string, value: string) {
  const existing = db.select().from(settings).where(eq(settings.key, key)).get();
  if (existing) db.update(settings).set({ value }).where(eq(settings.key, key)).run();
  else db.insert(settings).values({ key, value }).run();
}

/** Records one API call against the credit ledger. */
function recordUsage(accountId: string) {
  onUsage((u) => {
    db.insert(apiUsage)
      .values({
        provider: "socialcrawl",
        endpoint: u.endpoint,
        accountId,
        credits: u.credits,
        remaining: u.remaining,
        cached: u.cached,
      })
      .run();
  });
}

/**
 * Totals across every video we hold, using each video's most recent metrics.
 *
 * These MUST come from storage rather than the fetched page: a partial sync
 * returns ten videos, and summing only those would drop the account totals off
 * a cliff in the charts.
 */
function storedTotals(accountId: string): {
  totalViews: number;
  totalLikes: number;
  videoCount: number;
} {
  const row = db.get<{ total_views: number; total_likes: number; video_count: number }>(sql`
    SELECT
      COALESCE(SUM(latest.views), 0) AS total_views,
      COALESCE(SUM(latest.likes), 0) AS total_likes,
      COUNT(*)                       AS video_count
    FROM posts p
    JOIN (
      SELECT m.post_id, m.views, m.likes
      FROM post_metrics m
      JOIN (
        SELECT post_id, MAX(captured_at) AS captured_at
        FROM post_metrics GROUP BY post_id
      ) newest
        ON newest.post_id = m.post_id AND newest.captured_at = m.captured_at
      GROUP BY m.post_id
    ) latest ON latest.post_id = p.id
    WHERE p.account_id = ${accountId}
  `);
  return {
    totalViews: row?.total_views ?? 0,
    totalLikes: row?.total_likes ?? 0,
    videoCount: row?.video_count ?? 0,
  };
}

function applyProfile(accountId: string, profile: ProviderProfile) {
  db.update(accounts)
    .set({
      displayName: profile.displayName || undefined,
      avatarUrl: profile.avatarUrl ?? null,
      profileDeepLink: `https://www.tiktok.com/@${profile.handle}`,
    })
    .where(eq(accounts.id, accountId))
    .run();

  // Some fields are not reported by every endpoint. Writing zeroes there would
  // put a cliff in the growth chart, so carry the last known value forward.
  const previous = db
    .select()
    .from(metricSnapshots)
    .where(eq(metricSnapshots.accountId, accountId))
    .orderBy(desc(metricSnapshots.capturedAt))
    .limit(1)
    .get();

  const carry = (value: number | null, last: number | undefined) => value ?? last ?? 0;

  let created = 0;
  let updated = 0;

  for (const video of profile.videos) {
    const existing = db
      .select()
      .from(posts)
      .where(and(eq(posts.accountId, accountId), eq(posts.tiktokPostId, video.id)))
      .get();

    const fields = {
      caption: video.description,
      hashtags: JSON.stringify(video.hashtags),
      shareUrl: video.url,
      publishedAt: video.createdAt,
      durationSec: video.durationSec,
      musicTitle: video.musicTitle,
    };

    let postId: string;
    if (existing) {
      db.update(posts).set(fields).where(eq(posts.id, existing.id)).run();
      postId = existing.id;
      updated++;
    } else {
      const row = db
        .insert(posts)
        .values({ accountId, tiktokPostId: video.id, ...fields })
        .returning()
        .get();
      postId = row.id;
      created++;
    }

    // Always append, so per-video growth is tracked over time.
    db.insert(postMetrics)
      .values({
        postId,
        views: video.views,
        likes: video.likes,
        comments: video.comments,
        shares: video.shares,
        saves: video.saves,
      })
      .run();
  }

  // Snapshot AFTER upserting, so totals reflect everything stored.
  const totals = storedTotals(accountId);

  db.insert(metricSnapshots)
    .values({
      accountId,
      followers: carry(profile.followers, previous?.followers),
      following: carry(profile.following, previous?.following),
      // The videos endpoint reports no account-level like total, so sum the
      // per-video likes we hold rather than storing a zero.
      likes: profile.likes ?? totals.totalLikes ?? previous?.likes ?? 0,
      videoCount: totals.videoCount || carry(profile.videoCount, previous?.videoCount),
      totalViews: totals.totalViews,
    })
    .run();

  return { created, updated, totalViews: totals.totalViews };
}

/**
 * Pulls the account's public videos, stores them, and re-reads the account if
 * anything meaningful changed.
 *
 * `full` ignores what is already stored and walks every page - use it when you
 * want view counts on older videos refreshed, at roughly one credit per ten.
 */
export async function syncAccount(
  accountId: string,
  { full = false }: { full?: boolean } = {},
) {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) throw new Error(`No account ${accountId}`);

  const handle = account.handle.replace(/^@/, "");
  if (!handle) throw new Error("Account has no handle");

  // Ids we already hold. Paging stops at the first page that is not entirely
  // new, so a day with no new posts costs one credit instead of ten.
  const knownIds = new Set(
    db
      .select({ id: posts.tiktokPostId })
      .from(posts)
      .where(eq(posts.accountId, accountId))
      .all()
      .map((r) => r.id)
      .filter((id): id is string => Boolean(id)),
  );

  recordUsage(accountId);
  let profile;
  try {
    profile = await fetchProfileVideos(handle, {
      maxPages: full ? env.socialCrawlFullPages : env.socialCrawlPages,
      knownIds: full ? undefined : knownIds,
    });
  } finally {
    onUsage(null);
  }

  // Follower count is a separate endpoint and a separate credit, so it runs on
  // its own slower clock rather than on every sync.
  const followerKey = `sched:followers:${accountId}`;
  const lastFollowers = Number(
    db.select().from(settings).where(eq(settings.key, followerKey)).get()?.value ?? 0,
  );

  if (Date.now() - lastFollowers > env.socialCrawlFollowerDays * 86_400_000) {
    recordUsage(accountId);
    try {
      const followers = await fetchFollowerCount(handle);
      if (followers !== null) {
        profile.followers = followers;
        putSetting(followerKey, String(Date.now()));
      }
    } catch (err) {
      logEvent({
        accountId,
        level: "warn",
        type: "socialcrawl.followers_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      onUsage(null);
    }
  }

  const { created, updated, totalViews } = applyProfile(accountId, profile);

  logEvent({
    accountId,
    level: "success",
    type: "sync.done",
    message:
      `@${handle}: ${profile.videos.length} video(s) read (${created} new, ${updated} updated), ` +
      `${totalViews.toLocaleString()} total views · ${profile.creditsUsed} credit(s) used` +
      (profile.creditsRemaining !== null
        ? `, ${profile.creditsRemaining.toLocaleString()} remaining`
        : ""),
  });

  if (
    profile.creditsRemaining !== null &&
    profile.creditsRemaining <= env.socialCrawlLowCredits
  ) {
    logEvent({
      accountId,
      level: "warn",
      type: "socialcrawl.low_credits",
      message: `Only ${profile.creditsRemaining} SocialCrawl credit(s) left.`,
    });
  }

  await maybeAnalyse(accountId, created);

  return { profile, created, updated, totalViews };
}

/**
 * Re-reads the account when there is no analysis yet, when new videos arrived,
 * or when the last read has gone stale.
 */
export async function maybeAnalyse(accountId: string, newVideos = 0) {
  const existing = latestAnalysis(accountId);
  const ageDays = existing
    ? (Date.now() - existing.capturedAt.getTime()) / 86_400_000
    : Infinity;

  if (existing && newVideos === 0 && ageDays <= 7) return;

  try {
    await analyzeAccount(accountId);
  } catch (err) {
    // A failed reading must never fail the sync that produced the data.
    logEvent({
      accountId,
      level: "warn",
      type: "analysis.failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
