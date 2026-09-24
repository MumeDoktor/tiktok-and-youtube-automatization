/**
 * Finding long-form sources on YouTube.
 *
 * The rest of the pipeline cuts a source down; this is what decides there is a
 * source at all. Search is deliberately cheap - one flat-playlist call returns
 * a page of candidates with their length in about a second, without touching a
 * single video - so the expensive checks (captions, then the cut itself) only
 * ever run on something already worth checking.
 */
import { env } from "./env";
import { run, splitCmd, ytdlpAuth } from "./media";

export type YouTubeResult = {
  id: string;
  url: string;
  title: string;
  uploader: string | null;
  durationSec: number | null;
};

/**
 * The window a source has to fall in to be worth cutting.
 *
 * Below the floor there is nothing to select from - a ten-minute clip is
 * already somebody's edit, and asking for the best beat inside it just returns
 * the whole thing. Above the ceiling the transcript stops fitting in a single
 * read at a sensible cost.
 */
export const MIN_SOURCE_SEC = 20 * 60;
export const MAX_SOURCE_SEC = 5 * 60 * 60;

/** yt-dlp's `--print` fields, tab-separated. Titles contain everything else. */
const FIELDS = "%(id)s\t%(duration)s\t%(uploader)s\t%(title)s";

/**
 * Searches YouTube and returns candidates, longest-form first.
 *
 * Nothing here is downloaded or even opened - `--flat-playlist` reads the
 * search page only, which is what keeps this fast enough to run several
 * queries per decision.
 */
export async function searchYouTube(
  query: string,
  opts: { limit?: number; minSec?: number; maxSec?: number } = {},
): Promise<YouTubeResult[]> {
  const limit = opts.limit ?? 10;
  const minSec = opts.minSec ?? MIN_SOURCE_SEC;
  const maxSec = opts.maxSec ?? MAX_SOURCE_SEC;

  const { bin, prefix } = splitCmd(env.ytDlp);

  let stdout: string;
  try {
    ({ stdout } = await run(
      bin,
      [
        ...prefix,
        ...ytdlpAuth(),
        "--no-warnings",
        "--flat-playlist",
        "--print",
        FIELDS,
        `ytsearch${limit}:${query}`,
      ],
      { timeoutMs: 3 * 60_000 },
    ));
  } catch {
    // A failed search is not a failed run: the caller has other queries.
    return [];
  }

  const out: YouTubeResult[] = [];

  for (const line of stdout.split("\n")) {
    const [id, duration, uploader, ...rest] = line.trim().split("\t");
    if (!id || id === "NA") continue;

    const durationSec = Number(duration);
    // A live stream reports no duration, and so does a premiere that has not
    // aired. Both are unusable, and both land here as NaN.
    if (!Number.isFinite(durationSec) || durationSec <= 0) continue;
    if (durationSec < minSec || durationSec > maxSec) continue;

    out.push({
      id,
      url: `https://www.youtube.com/watch?v=${id}`,
      title: rest.join("\t").trim() || id,
      uploader: uploader && uploader !== "NA" ? uploader : null,
      durationSec,
    });
  }

  return out.sort((a, b) => (b.durationSec ?? 0) - (a.durationSec ?? 0));
}

/**
 * Whether a source carries an English caption track.
 *
 * The whole pipeline reads before it downloads, so a source with no captions
 * cannot be cut at all. One metadata call is far cheaper than finding out
 * three steps later, but it is still a call per video - only run it on a
 * shortlist, never on a whole page of search results.
 */
export async function hasCaptions(url: string): Promise<boolean> {
  const { bin, prefix } = splitCmd(env.ytDlp);
  try {
    const { stdout } = await run(
      bin,
      [
        ...prefix,
        ...ytdlpAuth(),
        "--skip-download",
        "--no-playlist",
        "--no-warnings",
        "--print",
        "%(subtitles.en.0.ext)s\t%(automatic_captions.en.0.ext)s",
        url,
      ],
      { timeoutMs: 2 * 60_000 },
    );

    const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
    // Either a real caption track or an auto-generated one will do; parseVtt
    // treats them the same once fetched.
    return line.split("\t").some((v) => v && v !== "NA");
  } catch {
    return false;
  }
}
