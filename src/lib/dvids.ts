import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env } from "./env";
import { isObj, num, str, toDate, type Raw } from "./social";
import { rawDir } from "./media";

const API = "https://api.dvidshub.net";

export class DvidsError extends Error {}

/**
 * DVIDS - the Defense Visual Information Distribution Service.
 *
 * Everything produced by the US Department of Defense is in the public domain,
 * so footage from here carries no copyright risk. Credit is courtesy, not a
 * legal requirement, but the pipeline burns it in anyway.
 *
 * The API needs a free key: https://api.dvidshub.net (email dvidsservicedesk@dvidshub.net)
 */

function requireKey(): string {
  if (!env.dvidsApiKey) {
    throw new Error(
      "DVIDS_API_KEY is not set. Request a free key at https://api.dvidshub.net (email dvidsservicedesk@dvidshub.net) and add it to .env.local.",
    );
  }
  return env.dvidsApiKey;
}

export type DvidsAsset = {
  id: string;
  title: string;
  description: string;
  publishedAt: Date | null;
  durationSec: number | null;
  /** Direct video file, when the asset detail exposes one. */
  downloadUrl: string | null;
  thumbnailUrl: string | null;
  branch: string | null;
  unit: string | null;
  location: string | null;
  pageUrl: string;
};

async function get(pathname: string, params: Record<string, string>): Promise<Raw> {
  const qs = new URLSearchParams({ ...params, api_key: requireKey() });
  const res = await fetch(`${API}${pathname}?${qs}`, { cache: "no-store" });
  const text = await res.text();

  let json: Raw;
  try {
    json = JSON.parse(text) as Raw;
  } catch {
    throw new DvidsError(`DVIDS returned non-JSON: ${text.slice(0, 200)}`);
  }

  if (Array.isArray(json.errors) && json.errors.length) {
    throw new DvidsError(`DVIDS: ${json.errors.join("; ")}`);
  }
  if (!res.ok) {
    throw new DvidsError(`DVIDS ${res.status}: ${text.slice(0, 200)}`);
  }
  return json;
}

/** Pulls the best available video URL out of an asset payload. */
function findVideoUrl(raw: Raw): string | null {
  // The detail endpoint nests renditions differently across asset types, so
  // walk the likely spots rather than assuming one shape.
  const direct = str(raw, "download_url", "url", "video_url", "src");
  if (direct && /\.(mp4|mov|m4v)(\?|$)/i.test(direct)) return direct;

  for (const key of ["video", "media", "files", "renditions", "assets"]) {
    const value = raw[key];
    if (Array.isArray(value)) {
      const best = value
        .filter(isObj)
        .map((v) => ({
          url: str(v, "src", "url", "download_url", "href"),
          height: num(v, "height", "vertical_resolution"),
        }))
        .filter((v) => v.url && /\.(mp4|mov|m4v)(\?|$)/i.test(v.url))
        // Prefer the largest that is still sane to download.
        .sort((a, b) => b.height - a.height)[0];
      if (best?.url) return best.url;
    }
    if (isObj(value)) {
      const nested = findVideoUrl(value);
      if (nested) return nested;
    }
  }
  return null;
}

function normalise(raw: Raw): DvidsAsset | null {
  const id = str(raw, "id", "asset_id");
  if (!id) return null;

  const title = str(raw, "title", "headline") ?? id;

  return {
    id,
    title,
    description: str(raw, "description", "short_description", "body") ?? "",
    publishedAt: toDate(raw.date_published ?? raw.date ?? raw.timestamp),
    durationSec: num(raw, "duration", "duration_seconds") || null,
    downloadUrl: findVideoUrl(raw),
    thumbnailUrl: str(raw, "thumbnail", "image", "thumb_url"),
    branch: str(raw, "branch", "service"),
    unit: str(raw, "unit_name", "unit"),
    location: str(raw, "location", "city", "country"),
    pageUrl: str(raw, "url", "page_url") ?? `https://www.dvidshub.net/video/${id}`,
  };
}

/**
 * Searches the archive for video assets.
 *
 * `q` should describe the footage wanted, not the story - the archive indexes
 * what is on screen ("F-22 Raptor takeoff"), not narrative.
 */
export async function searchVideos(
  q: string,
  { maxResults = 20, sort = "publishdate" } = {},
): Promise<DvidsAsset[]> {
  const json = await get("/search", {
    q,
    type: "video",
    max_results: String(Math.min(50, maxResults)),
    sort,
  });

  const results = Array.isArray(json.results) ? json.results : [];
  return results
    .filter(isObj)
    .map(normalise)
    .filter((a): a is DvidsAsset => a !== null);
}

/** Full detail for one asset, which is where the download URL usually lives. */
export async function getAsset(id: string): Promise<DvidsAsset | null> {
  const json = await get("/asset", { id: id.startsWith("video:") ? id : `video:${id}` });
  const result = isObj(json.results) ? json.results : isObj(json.result) ? json.result : null;
  return result ? normalise(result) : null;
}

/** Streams a public-domain asset to disk. */
export async function downloadAsset(asset: DvidsAsset, id: string): Promise<string> {
  if (!asset.downloadUrl) {
    throw new DvidsError(`Asset ${asset.id} exposes no downloadable video file.`);
  }

  fs.mkdirSync(rawDir, { recursive: true });
  const target = path.join(rawDir, `${id}.mp4`);

  const res = await fetch(asset.downloadUrl);
  if (!res.ok || !res.body) {
    throw new DvidsError(`Download failed: HTTP ${res.status}`);
  }

  await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(target));

  const size = fs.statSync(target).size;
  if (size < 10_000) {
    fs.unlinkSync(target);
    throw new DvidsError(`Download produced only ${size} bytes - not a usable video.`);
  }
  return target;
}

/** Raw passthrough for the probe script. */
export async function rawSearch(q: string): Promise<Raw> {
  return get("/search", { q, type: "video", max_results: "3" });
}
