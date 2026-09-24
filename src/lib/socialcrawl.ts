import { env } from "./env";
import {
  extractHashtags,
  isObj,
  num,
  str,
  toDate,
  type ProviderProfile,
  type ProviderVideo,
  type Raw,
} from "./social";

const BASE = "https://www.socialcrawl.dev/v1";

export class SocialCrawlError extends Error {}

function requireKey(): string {
  if (!env.socialCrawlKey) {
    throw new Error("SOCIALCRAWL_API_KEY is not set. Add it to .env.local.");
  }
  return env.socialCrawlKey;
}

/** Called after every request so the caller can record spend. */
export type UsageHook = (usage: {
  endpoint: string;
  credits: number;
  remaining: number | null;
  cached: boolean;
}) => void;

let usageHook: UsageHook | null = null;
export function onUsage(hook: UsageHook | null) {
  usageHook = hook;
}

export type Envelope = {
  success?: boolean;
  data?: Raw;
  credits_used?: number;
  credits_remaining?: number;
  request_id?: string;
  cached?: boolean;
  pagination?: Raw;
};

async function get(path: string): Promise<Envelope> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "x-api-key": requireKey() },
    cache: "no-store",
  });

  const text = await res.text();
  if (!res.ok) {
    throw new SocialCrawlError(
      `SocialCrawl ${res.status} on ${path}: ${text.slice(0, 300)}`,
    );
  }
  try {
    const envelope = JSON.parse(text) as Envelope;
    const cached = envelope.cached === true;
    usageHook?.({
      endpoint: path.split("?")[0],
      credits: envelope.credits_used ?? 0,
      // Cached responses report a meaningless 0 balance - treat it as unknown
      // rather than letting it trip the low-credit warning.
      remaining: cached ? null : (envelope.credits_remaining ?? null),
      cached,
    });
    return envelope;
  } catch {
    throw new SocialCrawlError(
      `SocialCrawl returned non-JSON on ${path}: ${text.slice(0, 200)}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Normalising                                                         */
/* ------------------------------------------------------------------ */

/**
 * Each item is { post: {...}, computed: {...} }. Everything interesting lives
 * under `post`, grouped into content / author / engagement / flags / ext.
 */
function normaliseItem(item: Raw, fallbackHandle: string): ProviderVideo | null {
  const post = isObj(item.post) ? item.post : item;
  const computed = isObj(item.computed) ? item.computed : {};

  const id = str(post, "id");
  if (!id) return null;

  const content = isObj(post.content) ? post.content : {};
  const author = isObj(post.author) ? post.author : {};
  const engagement = isObj(post.engagement) ? post.engagement : {};
  const flags = isObj(post.flags) ? post.flags : {};
  const ext = isObj(post.ext) ? post.ext : {};

  const handle = str(author, "username") ?? fallbackHandle;
  const description = str(content, "text", "description", "caption") ?? "";

  return {
    id,
    url: str(post, "url") ?? `https://www.tiktok.com/@${handle}/video/${id}`,
    description,
    // Prefer the ISO field; the epoch under ext is the fallback.
    createdAt:
      toDate(post.published_at) ?? toDate(ext.published_at_epoch),
    durationSec: num(content, "duration_seconds") || null,
    views: num(engagement, "views"),
    likes: num(engagement, "likes"),
    comments: num(engagement, "comments"),
    shares: num(engagement, "shares"),
    saves: num(engagement, "saves"),
    hashtags: extractHashtags(description, post),
    // Only a music_id is exposed, no title.
    musicTitle: str(post, "music_title") ?? str(ext, "music_title"),
    coverUrl: str(content, "thumbnail_url"),
    engagementRate: num(computed, "engagement_rate") || null,
    pinned: flags.pinned === true,
  };
}

/** Pulls the item array out of the envelope, tolerating shape changes. */
function itemsFrom(env_: Envelope): Raw[] {
  const data = env_.data;
  if (Array.isArray(data)) return (data as unknown[]).filter(isObj);
  if (!isObj(data)) return [];

  for (const key of ["items", "videos", "posts", "results"]) {
    const value = data[key];
    if (Array.isArray(value)) return value.filter(isObj);
  }
  return [];
}

/** Cursor for the next page, when the provider says there is one. */
function nextCursor(pagination: Raw | undefined): string | null {
  if (!pagination) return null;
  const hasMore =
    pagination.has_more === true ||
    pagination.hasMore === true ||
    pagination.has_next === true;
  if (!hasMore) return null;
  return (
    str(pagination, "next_cursor", "nextCursor", "cursor", "next", "offset") ?? null
  );
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export type FetchResult = ProviderProfile & {
  creditsUsed: number;
  creditsRemaining: number | null;
};

/**
 * Fetches a public profile's videos, following pagination.
 *
 * The profile/videos endpoint carries only author basics - no follower or
 * total-like counts - so those come back null and the sync layer keeps
 * whatever it already had rather than writing zeroes.
 */
export async function fetchProfileVideos(
  handle: string,
  {
    maxPages = 10,
    /**
     * Video ids already stored locally. Paging stops as soon as a page is not
     * entirely new, because older pages hold videos we already have. This is
     * the difference between 1 credit and 10 on a routine refresh.
     */
    knownIds,
  }: { maxPages?: number; knownIds?: Set<string> } = {},
): Promise<FetchResult> {
  const clean = handle.trim().replace(/^@/, "");
  if (!clean) throw new SocialCrawlError("No handle given");

  const videos: ProviderVideo[] = [];
  const seen = new Set<string>();

  let cursor: string | null = null;
  let creditsUsed = 0;
  let creditsRemaining: number | null = null;
  let author: Raw = {};

  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({ handle: clean });
    if (cursor) qs.set("cursor", cursor);

    const envelope: Envelope = await get(`/tiktok/profile/videos?${qs}`);

    creditsUsed += envelope.credits_used ?? 0;
    if (typeof envelope.credits_remaining === "number") {
      creditsRemaining = envelope.credits_remaining;
    }

    const items = itemsFrom(envelope);
    if (items.length === 0) break;

    for (const item of items) {
      const post = isObj(item.post) ? item.post : item;
      if (isObj(post.author) && Object.keys(author).length === 0) author = post.author;

      const video = normaliseItem(item, clean);
      // The provider can repeat a pinned post across pages.
      if (video && !seen.has(video.id)) {
        seen.add(video.id);
        videos.push(video);
      }
    }

    // Stop early unless this whole page was new to us.
    if (knownIds && items.length > 0) {
      const pageIds = items
        .map((item) => {
          const post = isObj(item.post) ? item.post : item;
          return str(post, "id");
        })
        .filter((id): id is string => Boolean(id));
      const allNew = pageIds.every((id) => !knownIds.has(id));
      if (!allNew) break;
    }

    cursor = nextCursor(envelope.pagination);
    if (!cursor) break;
  }

  if (videos.length === 0) {
    throw new SocialCrawlError(
      `No videos found for @${clean}. Check the handle and that the account is public. ` +
        `Run "npm run probe:socialcrawl -- ${clean}" to inspect the raw response.`,
    );
  }

  return {
    handle: str(author, "username") ?? clean,
    displayName: str(author, "display_name"),
    bio: null,
    avatarUrl: str(author, "avatar_url"),
    // This endpoint does not report profile totals.
    followers: null,
    following: null,
    likes: null,
    videoCount: videos.length,
    verified: author.verified === true,
    videos,
    analytics: null,
    creditsUsed,
    creditsRemaining,
  };
}

/**
 * Follower count, for one credit.
 *
 * The followers endpoint returns a page of follower profiles plus a `total`,
 * and that total is the account's follower count. The profiles themselves are
 * discarded - we only page once.
 */
export async function fetchFollowerCount(handle: string): Promise<number | null> {
  const clean = handle.trim().replace(/^@/, "");
  const envelope = await get(
    `/tiktok/user/followers?handle=${encodeURIComponent(clean)}&limit=1`,
  );
  const total = num(envelope.data, "total");
  return total > 0 ? total : null;
}

/** Raw passthrough for the probe script. */
export async function rawProfileVideos(handle: string): Promise<unknown> {
  return get(
    `/tiktok/profile/videos?handle=${encodeURIComponent(handle.replace(/^@/, ""))}`,
  );
}
