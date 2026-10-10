import { isObj, num, str, type Raw } from "./social";

const SEARCH = "https://archive.org/advancedsearch.php";

export class ArchiveError extends Error {}

/**
 * Internet Archive footage search, restricted to verifiably public-domain
 * material.
 *
 * IMPORTANT: archive.org is a hosting platform, not a public-domain library.
 * Anyone can upload anything, and a plain search returns mirrored YouTube
 * videos and TV captures that carry their original copyright. So this only
 * ever searches curated collections whose contents are public domain, and
 * additionally drops anything whose licence field contradicts that.
 */

/** Collections whose contents are public domain. Verified, not assumed. */
const PD_COLLECTIONS = ["prelinger"] as const;

/** Identifier prefixes that mark a mirrored upload rather than archive content. */
const MIRROR_PREFIXES = ["youtube-", "yt-", "twitch-", "tiktok-"];

export type ArchiveItem = {
  id: string;
  title: string;
  description: string;
  year: number | null;
  downloads: number;
  licenseUrl: string | null;
  pageUrl: string;
  /** Always "archive" - lets callers tell sources apart in a merged list. */
  source: "archive";
};

function looksPublicDomain(licenseUrl: string | null): boolean {
  if (!licenseUrl) return true; // Prelinger items are PD even when unlabelled.
  const l = licenseUrl.toLowerCase();
  if (l.includes("publicdomain") || l.includes("/cc0") || l.includes("mark")) return true;
  // A restrictive CC licence (nc, nd) is not what we want for reuse.
  return !l.includes("/by-nc") && !l.includes("/by-nd");
}

function normalise(raw: Raw): ArchiveItem | null {
  const id = str(raw, "identifier");
  if (!id) return null;

  // Mirrored uploads carry the original creator's copyright.
  if (MIRROR_PREFIXES.some((p) => id.toLowerCase().startsWith(p))) return null;

  const licenseUrl = str(raw, "licenseurl");
  if (!looksPublicDomain(licenseUrl)) return null;

  const description = Array.isArray(raw.description)
    ? raw.description.filter((d) => typeof d === "string").join(" ")
    : (str(raw, "description") ?? "");

  return {
    id,
    title: str(raw, "title") ?? id,
    description,
    year: num(raw, "year") || null,
    downloads: num(raw, "downloads"),
    licenseUrl,
    pageUrl: `https://archive.org/details/${id}`,
    source: "archive",
  };
}

/**
 * Searches the public-domain collections for footage.
 *
 * Results are ordered by download count, which is a decent proxy for how
 * watchable a given reel actually is.
 */
export async function searchArchive(
  query: string,
  { maxResults = 15 } = {},
): Promise<ArchiveItem[]> {
  const clean = query.replace(/["():]/g, " ").trim();
  if (!clean) return [];

  const collections = PD_COLLECTIONS.map((c) => `collection:(${c})`).join(" OR ");
  const q = `(${collections}) AND mediatype:(movies) AND (${clean})`;

  const params = new URLSearchParams({
    q,
    rows: String(Math.min(50, maxResults)),
    output: "json",
  });
  for (const field of [
    "identifier",
    "title",
    "description",
    "year",
    "downloads",
    "licenseurl",
  ]) {
    params.append("fl[]", field);
  }
  params.append("sort[]", "downloads desc");

  const res = await fetch(`${SEARCH}?${params}`, { cache: "no-store" });
  if (!res.ok) {
    throw new ArchiveError(`Internet Archive search failed: HTTP ${res.status}`);
  }

  const json = (await res.json()) as { response?: { docs?: unknown[] } };
  const docs = json.response?.docs ?? [];

  return docs
    .filter(isObj)
    .map(normalise)
    .filter((i): i is ArchiveItem => i !== null);
}

/**
 * The page URL, which yt-dlp resolves to the actual video file.
 *
 * There is no separate download step here: yt-dlp has a native archive.org
 * extractor, so the existing downloader handles these like any other URL.
 */
export function downloadUrlFor(item: ArchiveItem): string {
  return item.pageUrl;
}
