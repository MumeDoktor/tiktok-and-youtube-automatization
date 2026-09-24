import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";

/** Short random id. Readable enough to paste into a log line. */
export const newId = () => Math.random().toString(36).slice(2, 12);

const createdAt = () =>
  integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`);

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey().$defaultFn(newId),
  handle: text("handle").notNull().unique(),
  displayName: text("display_name").notNull(),
  avatarUrl: text("avatar_url"),
  /** Public profile URL from user.info.profile - powers the View on TikTok link. */
  profileDeepLink: text("profile_deep_link"),

  /** Free-text niche, e.g. "gym motivation for men 18-30". */
  niche: text("niche").notNull().default(""),
  targetCountry: text("target_country").notNull().default("US"),
  /** IANA zone the posting schedule is computed in. */
  timezone: text("timezone").notNull().default("America/New_York"),

  status: text("status", { enum: ["active", "paused"] })
    .notNull()
    .default("active"),

  /**
   * Makes a video ahead of each measured best posting time and notifies the
   * owner. Off by default: it spends API credits and render time unasked.
   */
  autopilot: integer("autopilot", { mode: "boolean" }).notNull().default(false),

  createdAt: createdAt(),
});

/* ------------------------------------------------------------------ */
/* Content profile - the content type you have already made            */
/* ------------------------------------------------------------------ */

export const contentProfiles = sqliteTable("content_profiles", {
  id: text("id").primaryKey().$defaultFn(newId),
  accountId: text("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),

  /** What the account posts, in your words. The agent treats this as law. */
  description: text("description").notNull().default(""),
  toneOfVoice: text("tone_of_voice").notNull().default(""),
  /** JSON string[] - hook patterns that work for this account. */
  hookStyles: text("hook_styles").notNull().default("[]"),
  captionTemplate: text("caption_template").notNull().default(""),
  hashtagStrategy: text("hashtag_strategy").notNull().default(""),
  /** JSON string[] - hard rules the agent must never break. */
  doNotDo: text("do_not_do").notNull().default("[]"),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

/* ------------------------------------------------------------------ */
/* Agents - one per account                                            */
/* ------------------------------------------------------------------ */

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey().$defaultFn(newId),
  accountId: text("account_id")
    .notNull()
    .unique()
    .references(() => accounts.id, { onDelete: "cascade" }),

  name: text("name").notNull(),
  /** Extra personality/instructions layered onto the base system prompt. */
  persona: text("persona").notNull().default(""),

  status: text("status", { enum: ["active", "paused"] })
    .notNull()
    .default("active"),

  lastRunAt: integer("last_run_at", { mode: "timestamp" }),
  createdAt: createdAt(),
});

/* ------------------------------------------------------------------ */
/* Account-level metrics time series                                   */
/* ------------------------------------------------------------------ */

export const metricSnapshots = sqliteTable(
  "metric_snapshots",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    capturedAt: integer("captured_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),

    followers: integer("followers").notNull().default(0),
    following: integer("following").notNull().default(0),
    likes: integer("likes").notNull().default(0),
    videoCount: integer("video_count").notNull().default(0),
    profileViews: integer("profile_views").notNull().default(0),
    /** Sum of views across all videos at capture time. */
    totalViews: integer("total_views").notNull().default(0),
  },
  (t) => [index("metrics_account_time").on(t.accountId, t.capturedAt)],
);


/* ------------------------------------------------------------------ */
/* Posts                                                               */
/* ------------------------------------------------------------------ */

export const posts = sqliteTable(
  "posts",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    caption: text("caption").notNull().default(""),
    /** JSON string[] */
    hashtags: text("hashtags").notNull().default("[]"),
    /** Seconds. Only set for observed videos. */
    durationSec: real("duration_sec"),
    /** Sound name, when the scrape exposes it. */
    musicTitle: text("music_title"),
    publishedAt: integer("published_at", { mode: "timestamp" }),

    /** TikTok's video id - the key videos are matched on across syncs. */
    tiktokPostId: text("tiktok_post_id"),
    shareUrl: text("share_url"),

    createdAt: createdAt(),
  },
  (t) => [index("posts_account").on(t.accountId, t.tiktokPostId)],
);

export const postMetrics = sqliteTable(
  "post_metrics",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    postId: text("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    capturedAt: integer("captured_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),

    views: integer("views").notNull().default(0),
    likes: integer("likes").notNull().default(0),
    comments: integer("comments").notNull().default(0),
    shares: integer("shares").notNull().default(0),
    /** Bookmarks. Exposed by SocialCrawl, not by the official API. */
    saves: integer("saves").notNull().default(0),
    /** Seconds. From the TikTok video query API. */
    avgWatchTime: real("avg_watch_time"),
    completionRate: real("completion_rate"),
  },
  (t) => [index("post_metrics_post_time").on(t.postId, t.capturedAt)],
);

/* ------------------------------------------------------------------ */
/* Clips - source footage cut into finished vertical videos            */
/* ------------------------------------------------------------------ */

export const clips = sqliteTable(
  "clips",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),

    /**
     * url   - a link you pasted; rights are your call
     * dvids - US DoD archive, public domain by law
     */
    sourceType: text("source_type", { enum: ["url", "dvids"] })
      .notNull()
      .default("url"),
    /** The URL pasted, or the DVIDS asset page. */
    sourceUrl: text("source_url").notNull(),
    /** DVIDS asset id, when sourceType is dvids. */
    dvidsId: text("dvids_id"),
    sourceTitle: text("source_title"),
    sourceUploader: text("source_uploader"),
    sourceDurationSec: real("source_duration_sec"),
    /** Timestamped transcript, kept so a decision can be re-examined. */
    transcript: text("transcript"),

    // --- the agent's decision ---
    startSec: real("start_sec"),
    endSec: real("end_sec"),
    hookText: text("hook_text"),
    caption: text("caption"),
    /** JSON string[] */
    hashtags: text("hashtags").notNull().default("[]"),
    /** Why this beat, or why the source was declined. */
    rationale: text("rationale"),
    /**
     * JSON [{at, message}] - a running log of what the agent did, appended as
     * it works. Producing a clip takes minutes, and a spinner with no words
     * is indistinguishable from a hang.
     */
    progress: text("progress").notNull().default("[]"),
    /** First line spoken in the chosen segment, for checking the cut. */
    quote: text("quote"),
    /** The posting slot autopilot made this clip for. Null for clips asked for by hand. */
    scheduledFor: integer("scheduled_for", { mode: "timestamp" }),

    // --- the edit ---
    /**
     * JSON [{text, intent}] - the narration, one sentence per line. This is
     * the spine: the voice track is spoken from it and every cut, caption and
     * emphasis is timed against the result.
     */
    script: text("script"),
    /**
     * The question the opening plants and the payoff answers.
     *
     * Stored so a video that nobody watched to the end can be read back and
     * asked the only question that matters about it: was there ever a reason
     * to keep watching?
     */
    openLoop: text("open_loop"),
    /**
     * JSON Look - which on-screen layers this particular clip uses. Chosen per
     * clip rather than fixed, because a 1962 carrier story and a podcast
     * cutdown should not be dressed the same way.
     */
    look: text("look"),
    /** JSON [{text, startMs, endMs, line, emphasis}] from the narrator. */
    words: text("words"),
    /** JSON [{atSec, durationSec, move, whatIsVisible}] - the shot list. */
    shots: text("shots"),
    /**
     * JSON [{atMs, effect, intensity}] - effects fired on individual words,
     * already resolved against the narrator's timings. Kept so a video can be
     * asked afterwards which words it chose to lean on.
     */
    hits: text("hits"),
    /** The spoken track, joined from the per-line pieces. */
    voicePath: text("voice_path"),
    /** Licensed bed picked from media/music, or null for voice only. */
    musicPath: text("music_path"),

    // --- files ---
    rawPath: text("raw_path"),
    outputPath: text("output_path"),
    thumbnailPath: text("thumbnail_path"),
    outputDurationSec: real("output_duration_sec"),
    sizeBytes: integer("size_bytes"),

    /**
     * declined is a success, not a failure: most sources hold nothing worth
     * cutting, and saying so costs one transcript instead of a download.
     */
    status: text("status", {
      enum: [
        /** Deciding what video to make, before there is any source at all. */
        "deciding",
        "queued",
        "transcribing",
        "choosing",
        "scripting",
        "voicing",
        "looking",
        "declined",
        "downloading",
        "editing",
        /** Analysed by the After Effects editor, blocked until After Effects is open and free. */
        "waiting_for_ae",
        /** Built in After Effects, waiting for the owner to review and export it. */
        "review_in_ae",
        "ready",
        "posted",
        "failed",
      ],
    })
      .notNull()
      .default("queued"),
    error: text("error"),

    createdAt: createdAt(),
  },
  (t) => [index("clips_account_status").on(t.accountId, t.status)],
);

/* ------------------------------------------------------------------ */
/* Chat + memory                                                       */
/* ------------------------------------------------------------------ */

export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    createdAt: createdAt(),
  },
  (t) => [index("chat_account_time").on(t.accountId, t.createdAt)],
);

/**
 * Durable facts distilled from chat. These are injected into EVERY agent
 * call - chat and autonomous runs alike - so something you say once in chat
 * keeps steering how the agent posts long afterwards.
 */
export const agentMemory = sqliteTable(
  "agent_memory",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: ["directive", "fact", "preference", "learning"],
    })
      .notNull()
      .default("fact"),
    content: text("content").notNull(),
    source: text("source", { enum: ["chat", "analysis", "manual"] })
      .notNull()
      .default("chat"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("memory_account").on(t.accountId, t.active)],
);

/* ------------------------------------------------------------------ */
/* Market analysis                                                     */
/* ------------------------------------------------------------------ */

export const marketInsights = sqliteTable("market_insights", {
  id: text("id").primaryKey().$defaultFn(newId),
  accountId: text("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  capturedAt: integer("captured_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),

  summary: text("summary").notNull().default(""),
  /** JSON - [{ hashtag, why }] */
  trendingHashtags: text("trending_hashtags").notNull().default("[]"),
  /** JSON - [{ title, angle, hook, why, searchQuery }] */
  topicIdeas: text("topic_ideas").notNull().default("[]"),
  /** JSON - [{ dayOfWeek, hourLocal, score, why }] */
  bestPostTimes: text("best_post_times").notNull().default("[]"),
  rawAnalysis: text("raw_analysis"),
});

/* ------------------------------------------------------------------ */
/* Job queue + activity log                                            */
/* ------------------------------------------------------------------ */

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    accountId: text("account_id").references(() => accounts.id, {
      onDelete: "cascade",
    }),
    type: text("type", {
      enum: [
        "sync",
        "analyze",
        "make_clip",
        "find_footage",
        "produce",
        "find_source",
        "edit_ae",
        "export_ae",
        "autopilot",
        "publish_phone",
      ],
    }).notNull(),
    /** JSON payload */
    payload: text("payload").notNull().default("{}"),
    status: text("status", {
      enum: ["queued", "running", "done", "failed", "cancelled"],
    })
      .notNull()
      .default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lastError: text("last_error"),
    runAt: integer("run_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    startedAt: integer("started_at", { mode: "timestamp" }),
    finishedAt: integer("finished_at", { mode: "timestamp" }),
    createdAt: createdAt(),
  },
  (t) => [index("jobs_status_runat").on(t.status, t.runAt)],
);

export const agentEvents = sqliteTable(
  "agent_events",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    accountId: text("account_id").references(() => accounts.id, {
      onDelete: "cascade",
    }),
    level: text("level", { enum: ["info", "warn", "error", "success"] })
      .notNull()
      .default("info"),
    type: text("type").notNull(),
    message: text("message").notNull(),
    meta: text("meta"),
    createdAt: createdAt(),
  },
  (t) => [index("events_account_time").on(t.accountId, t.createdAt)],
);

/** Per-call credit ledger, so spend is visible and projectable. */
export const apiUsage = sqliteTable(
  "api_usage",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    provider: text("provider").notNull(),
    endpoint: text("endpoint").notNull(),
    accountId: text("account_id"),
    credits: integer("credits").notNull().default(0),
    /** Balance reported by the provider. Null on cached (free) responses. */
    remaining: integer("remaining"),
    cached: integer("cached", { mode: "boolean" }).notNull().default(false),
    capturedAt: integer("captured_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [index("usage_time").on(t.capturedAt)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export type Account = typeof accounts.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type ContentProfile = typeof contentProfiles.$inferSelect;
export type MetricSnapshot = typeof metricSnapshots.$inferSelect;
export type Post = typeof posts.$inferSelect;
export type PostMetric = typeof postMetrics.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type AgentMemory = typeof agentMemory.$inferSelect;
export type MarketInsight = typeof marketInsights.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type AgentEvent = typeof agentEvents.$inferSelect;
export type ApiUsage = typeof apiUsage.$inferSelect;
export type Clip = typeof clips.$inferSelect;
