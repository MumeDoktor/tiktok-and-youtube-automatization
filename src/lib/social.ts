/**
 * Shared shape for every TikTok data provider.
 *
 * Providers differ in their JSON field names, so each one normalises into
 * these types and the sync layer never has to care where data came from.
 */

export type ProviderVideo = {
  id: string;
  url: string;
  description: string;
  createdAt: Date | null;
  durationSec: number | null;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  hashtags: string[];
  musicTitle: string | null;
  coverUrl: string | null;
  saves: number;
  /** Provider-computed engagement rate, 0-1, when supplied. */
  engagementRate: number | null;
  pinned: boolean;
};

export type ProviderProfile = {
  handle: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  /** null means the provider did not report it - do NOT store as zero. */
  followers: number | null;
  following: number | null;
  likes: number | null;
  videoCount: number | null;
  verified: boolean;
  videos: ProviderVideo[];
  analytics: Record<string, unknown> | null;
};

/* ------------------------------------------------------------------ */
/* Field-plucking helpers                                              */
/* ------------------------------------------------------------------ */

export type Raw = Record<string, unknown>;

export function isObj(v: unknown): v is Raw {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** First present numeric value among the given keys, searching nested objects. */
export function num(obj: Raw | undefined, ...keys: string[]): number {
  if (!obj) return 0;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
      return Number(v);
    }
  }
  return 0;
}

export function str(obj: Raw | undefined, ...keys: string[]): string | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

/**
 * Timestamps arrive as seconds, milliseconds, or ISO strings depending on the
 * provider and the field. Normalise, and reject anything implausible.
 */
export function toDate(value: unknown): Date | null {
  if (typeof value === "number" && value > 0) {
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string" && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && asNumber > 1e9) return toDate(asNumber);
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function extractHashtags(description: string, raw: Raw): string[] {
  const field = raw.hashtags ?? raw.challenges ?? raw.tags;
  if (Array.isArray(field)) {
    const names = field
      .map((h) =>
        typeof h === "string"
          ? h
          : isObj(h)
            ? ((h.name ?? h.title ?? h.hashtagName) as string | undefined)
            : undefined,
      )
      .filter((h): h is string => Boolean(h));
    if (names.length) return names.map((h) => h.replace(/^#/, ""));
  }
  return [...description.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1]);
}
