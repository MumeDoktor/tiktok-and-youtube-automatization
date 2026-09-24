import os from "node:os";
import path from "node:path";

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

export type DailySlot = { hour: number; minute: number };

/** "12:00,19:30" -> sorted slots. "learned" (or nothing valid) -> []. */
function parseSlots(raw: string): DailySlot[] {
  if (raw.trim().toLowerCase() === "learned") return [];
  return raw
    .split(",")
    .map((s) => /^\s*(\d{1,2})(?::(\d{2}))?\s*$/.exec(s))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ hour: Number(m[1]), minute: Number(m[2] ?? 0) }))
    .filter((s) => s.hour < 24 && s.minute < 60)
    .sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
}

export const env = {
  anthropicApiKey: optional("ANTHROPIC_API_KEY"),

  // SocialCrawl - public TikTok data. 1 page = ~10 videos = 1 credit.
  socialCrawlKey: optional("SOCIALCRAWL_API_KEY"),
  /** Page cap for a routine sync. Adaptive paging usually stops well before it. */
  socialCrawlPages: Number(optional("SOCIALCRAWL_MAX_PAGES") ?? 2),
  /** Page cap when refreshing every video, including old ones. */
  socialCrawlFullPages: Number(optional("SOCIALCRAWL_FULL_PAGES") ?? 20),
  /** Warn in the activity log below this many credits. */
  socialCrawlLowCredits: Number(optional("SOCIALCRAWL_LOW_CREDITS") ?? 20),
  /** Days between scheduled syncs. */
  socialCrawlSyncDays: Number(optional("SOCIALCRAWL_SYNC_DAYS") ?? 1),
  /** How often to spend a credit on the follower count. */
  socialCrawlFollowerDays: Number(optional("SOCIALCRAWL_FOLLOWER_DAYS") ?? 7),

  // DVIDS - US Department of Defense archive. Public domain footage.
  // Key by request: email dvidsservicedesk@dvidshub.net · docs at api.dvidshub.net
  dvidsApiKey: optional("DVIDS_API_KEY"),

  // Local tooling for clip production
  ytDlp: optional("YTDLP_CMD") ?? "python -m yt_dlp",
  /**
   * YouTube bot checks. Unset is fine until YouTube starts asking; when it
   * does, every yt-dlp call fails with "Sign in to confirm you're not a bot"
   * and one of these is the fix.
   *
   * YTDLP_COOKIES_FROM_BROWSER - a browser name, e.g. "chrome" or "firefox".
   * YTDLP_COOKIE_FILE          - a Netscape cookies.txt, for a headless box.
   */
  ytDlpCookiesFromBrowser: optional("YTDLP_COOKIES_FROM_BROWSER"),
  ytDlpCookieFile: optional("YTDLP_COOKIE_FILE"),
  ffmpeg: optional("FFMPEG_CMD") ?? "ffmpeg",
  ffprobe: optional("FFPROBE_CMD") ?? "ffprobe",
  mediaDir: optional("MEDIA_DIR") ?? "./media",
  /** Interpreter used for the edge-tts helper in src/lib/tts.py. */
  python: optional("PYTHON_CMD") ?? "python",

  // Narration. edge-tts is free and returns word timings, which is what the
  // edit is cut against - see src/lib/tts.ts.
  ttsVoice: optional("TTS_VOICE") ?? "en-US-GuyNeural",
  /** edge-tts rate, e.g. "-8%" to slow a narrator down. */
  ttsRate: optional("TTS_RATE") ?? "+0%",

  /**
   * Days between unattended source hunts: search YouTube for an interview
   * worth cutting and produce every clip in it. 0 turns it off, which is the
   * default - it spends API credits and render time without being asked.
   */
  podcastHuntDays: Number(optional("PODCAST_HUNT_DAYS") ?? 0),

  /**
   * Most clips cut from one interview. 1 means one request makes one video;
   * higher lets a long podcast fan out into several, up to 5.
   */
  clipsPerSource: Math.max(1, Math.min(5, Number(optional("CLIPS_PER_SOURCE") ?? 1))),

  /**
   * How many sources one request may read before giving up. A source that
   * holds nothing worth cutting is a normal answer, so stopping at the first
   * one means a request fails that a second interview would have satisfied.
   */
  sourceTries: Math.max(1, Math.min(5, Number(optional("SOURCE_TRIES") ?? 3))),

  /** Shortest finished video, in seconds. */
  clipMinSec: Math.max(5, Number(optional("CLIP_MIN_SEC") ?? 25)),
  /** Longest finished video, in seconds. */
  clipMaxSec: Math.max(10, Number(optional("CLIP_MAX_SEC") ?? 30)),

  /**
   * Videos a week autopilot makes for each account that has it switched on,
   * on that account's strongest measured days. One a day at most.
   */
  autopilotPerWeek: Math.max(1, Math.min(7, Number(optional("AUTOPILOT_VIDEOS_PER_WEEK") ?? 3))),
  /**
   * Minutes before a posting slot that production starts. It has to cover the
   * render - and your review, when After Effects does the edit.
   */
  autopilotLeadMinutes: Math.max(30, Number(optional("AUTOPILOT_LEAD_MINUTES") ?? 180)),

  /**
   * Fixed daily posting times in the account's timezone, e.g. "12:00,19:00".
   * Set to "learned" to aim at the best hours measured from the account's own
   * posts instead (AUTOPILOT_VIDEOS_PER_WEEK of them).
   */
  autopilotSlots: parseSlots(optional("AUTOPILOT_SLOTS") ?? "12:00,19:00"),

  /**
   * Post finished autopilot videos through the Android phone plugged into this
   * PC, at their slot. Off unless set to "on" - it posts publicly, as you.
   */
  phonePublish: optional("PHONE_PUBLISH") === "on",
  /** Walk the whole posting flow but stop before tapping Post. */
  phoneDryRun: optional("PHONE_DRY_RUN") === "on",
  /** adb.exe. Defaults to the Android SDK's copy. */
  adb:
    optional("ADB_PATH") ??
    path.join(os.homedir(), "AppData", "Local", "Android", "Sdk", "platform-tools", "adb.exe"),
  /** Which device, when more than one is attached (see `adb devices`). */
  phoneSerial: optional("PHONE_SERIAL"),
  /** The TikTok app. com.zhiliaoapp.musically is the US/global build. */
  tiktokPackage: optional("TIKTOK_PACKAGE") ?? "com.zhiliaoapp.musically",
  /** Tries at posting one video before giving up, 1m, 4m, 9m... apart. */
  publishAttempts: Math.max(1, Number(optional("PUBLISH_ATTEMPTS") ?? 6)),

  /**
   * Export the After Effects edit automatically as soon as it is built,
   * instead of waiting for you to review and export it. "off" restores review.
   */
  aeAutoExport: optional("AE_AUTO_EXPORT") !== "off",

  /** Poll interval for the worker loop, in ms. */
  workerIntervalMs: Number(optional("WORKER_INTERVAL_MS") ?? 15_000),

  /**
   * Who edits a cut. "ae" hands it to ai_aget_ae, which builds the edit inside
   * After Effects for you to review and export; "remotion" renders it here,
   * unattended. "ae" falls back to Remotion when the editor is not installed.
   */
  editorBackend: (optional("EDITOR_BACKEND") === "remotion" ? "remotion" : "ae") as
    | "ae"
    | "remotion",
  /** Where ai_aget_ae lives, relative to this project. */
  aeEditorDir: optional("AE_EDITOR_DIR") ?? "../ai_aget_ae",
  /** Minutes between checks while a clip waits for After Effects to be free. */
  aeRetryMinutes: Number(optional("AE_RETRY_MINUTES") ?? 2),
  /** Windows notifications when a clip needs you. "off" keeps them in the activity log. */
  desktopNotifications: optional("DESKTOP_NOTIFICATIONS") !== "off",
} as const;

export const MODELS = {
  /** Account analysis. Runs rarely; quality matters. */
  strategy: "claude-opus-5",
  /** Per-account chat. Fast and cheap enough for conversation. */
  chat: "claude-sonnet-5",
} as const;

export function requireAnthropicKey(): string {
  if (!env.anthropicApiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env.local (see .env.example).",
    );
  }
  return env.anthropicApiKey;
}
