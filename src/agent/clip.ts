import fs from "node:fs";
import { eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "@/db";
import { accounts, clips, contentProfiles } from "@/db/schema";
import { anthropic } from "@/lib/anthropic";
import { env, MODELS } from "@/lib/env";
import {
  downloadVideo,
  extractThumbnail,
  fetchShots,
  fetchTranscript,
  probe,
  probeSource,
  renderTranscript,
  type Cue,
} from "@/lib/media";
import {
  DEFAULT_LOOK,
  normaliseLook,
  resolveHits,
  type EffectHit,
  type Look,
  type Move,
  type Transition,
} from "@/lib/look";
import {
  renderSentences,
  toSentences,
  type TranscriptLine,
} from "@/lib/transcript";
import { planSoundDesign } from "@/lib/mix";
import { renderClip } from "@/lib/remotion";
import { aeTargetSec, sourceWindowSec, useAeEditor } from "@/lib/ae-editor";
import { latestAnalysis } from "./account-analysis";
import type { AeEditPayload } from "./ae-edit";
import { enqueue, logEvent, noteProgress } from "./events";

/* ------------------------------------------------------------------ */
/* Segment selection                                                   */
/* ------------------------------------------------------------------ */

const SEGMENT_SCHEMA = {
  type: "object" as const,
  properties: {
    start: {
      type: "string",
      description:
        'Where the segment starts: the [MM:SS] stamp of a transcript line, copied exactly, e.g. "37:04". Use the line just before the first words so the clip does not open mid-syllable.',
    },
    end: {
      type: "string",
      description:
        'Where it ends: the [MM:SS] stamp of the transcript line just after the payoff lands, copied exactly, e.g. "37:41".',
    },
    hookText: {
      type: "string",
      description:
        "On-screen text burned across the upper third. Max ~60 characters. A story premise, never a noun or a label.",
    },
    caption: {
      type: "string",
      description: "The TikTok caption. This carries the whole story hook for this account.",
    },
    hashtags: {
      type: "array",
      items: { type: "string" },
      description: "3-5, without the # prefix.",
    },
    quote: {
      type: "string",
      description: "The first sentence spoken in the chosen segment, so the cut can be verified against the transcript.",
    },
    reason: {
      type: "string",
      description:
        "Why THIS beat will perform for this account, citing the account's own numbers. One per segment - a shared justification means they were not judged separately.",
    },
  },
  required: ["start", "end", "hookText", "caption", "quote", "reason"],
  additionalProperties: false,
};

const PICK_TOOL: Anthropic.Tool = {
  name: "choose_segments",
  description:
    "Choose every segment of this source worth cutting into its own short video, or return an empty list if nothing in it is good enough.",
  input_schema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description:
          "The read on the source as a whole. When the list is empty this is the only thing the owner sees, so say plainly what was missing.",
      },
      segments: {
        type: "array",
        items: SEGMENT_SCHEMA,
        description:
          "One entry per beat that stands on its own, best first. Empty is a valid and common answer. " +
          "Segments must not overlap: a beat used twice is the same video posted twice.",
      },
    },
    required: ["reason", "segments"],
    additionalProperties: false,
  },
};

export type Segment = {
  startSec: number;
  endSec: number;
  hookText?: string;
  caption?: string;
  hashtags?: string[];
  quote?: string;
  reason: string;
};

/** A segment as the model returns it, with transcript stamps rather than seconds. */
type SegmentInput = Omit<Segment, "startSec" | "endSec"> & { start?: unknown; end?: unknown };

/**
 * "37:04" or "1:02:03" -> seconds. Null for anything else.
 *
 * The model is asked for stamps copied off the transcript rather than for
 * seconds, because converting them is where it slipped: "[37:04]" once came
 * back as 370.4 seconds.
 */
export function parseStamp(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const parts = value.trim().replace(/^\[|\]$/g, "").split(":").map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function normaliseWords(s: string): string {
  return s
    .toLowerCase()
    .replace(/&nbsp;/g, " ")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Moves a segment onto the place its quote is actually spoken.
 *
 * The quote is copied from the transcript, so it can be found there, and words
 * are much harder to get wrong than a number. When the quote turns up away from
 * the stamp, the words win: a stamp misread once downloaded eight seconds of an
 * unrelated tangent under a hook about a story told half an hour later.
 */
export function anchorToQuote(segment: Segment, cues: Cue[]): Segment {
  const phrase = normaliseWords(segment.quote ?? "").split(" ").filter(Boolean).slice(0, 8);
  if (phrase.length < 4) return segment;

  // Captions split sentences across cues, so search one joined text that
  // remembers where each cue begins.
  let text = "";
  const cueAt: Array<{ offset: number; sec: number }> = [];
  for (const c of cues) {
    const t = normaliseWords(c.text);
    if (!t) continue;
    cueAt.push({ offset: text.length, sec: c.start });
    text += `${t} `;
  }

  // A phrase can recur ("I'll tell you ... I'll tell you"), so take the
  // occurrence nearest the stamp the model gave.
  const needle = phrase.join(" ");
  let best: number | null = null;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
    let sec = cueAt[0].sec;
    for (const c of cueAt) {
      if (c.offset > at) break;
      sec = c.sec;
    }
    if (best === null || Math.abs(sec - segment.startSec) < Math.abs(best - segment.startSec)) {
      best = sec;
    }
  }

  if (best === null || Math.abs(best - segment.startSec) <= 5) return segment;
  const length = segment.endSec - segment.startSec;
  const startSec = Math.max(0, best - 0.5);
  return { ...segment, startSec, endSec: startSec + length };
}

export type SegmentChoice = {
  /** The read on the source as a whole; the decline note when nothing was found. */
  reason: string;
  segments: Segment[];
};

/**
 * How many clips one source is allowed to yield.
 *
 * Roughly one per twenty minutes: a ten-minute interview holding five postable
 * beats is not a thing that happens, and letting the model return five means
 * getting five mediocre ones. The cap is an upper bound, not a target - the
 * model is told to return fewer, or none.
 *
 * CLIPS_PER_SOURCE caps it further, and defaults to 1: one request, one video.
 */
export function segmentCap(durationSec: number): number {
  const bySource = Math.max(1, Math.min(5, Math.floor(durationSec / 1200)));
  return Math.min(env.clipsPerSource, bySource);
}

/**
 * Drops segments that overlap one already kept, and anything malformed.
 *
 * The model is told not to overlap, but two beats a few seconds apart is an
 * easy mistake for it to make and an expensive one to find later - it renders
 * as two near-identical videos, which on one account reads as a repost.
 */
export function pruneSegments(
  segments: Segment[],
  cap: number,
  lengthWindow?: { minSec: number; maxSec: number },
): Segment[] {
  const kept: Segment[] = [];

  for (const s of segments) {
    if (kept.length >= cap) break;
    if (typeof s?.startSec !== "number" || typeof s?.endSec !== "number") continue;

    const start = Math.max(0, s.startSec);
    const end = s.endSec;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 3) continue;
    // A few seconds of slack either side: a story that ends just past the
    // window is still the story, and cutting it short would lose the payoff.
    if (
      lengthWindow &&
      (end - start < lengthWindow.minSec - 3 || end - start > lengthWindow.maxSec + 5)
    ) {
      continue;
    }

    if (kept.some((k) => start < k.endSec && end > k.startSec)) continue;

    kept.push({ ...s, startSec: start, endSec: end });
  }

  return kept;
}

/**
 * Reads a transcript and picks every beat worth cutting.
 *
 * Runs BEFORE the video is downloaded - captions are kilobytes, videos are
 * gigabytes - so a source with nothing usable costs nothing but a few tokens.
 * One read of a four-hour podcast costs the same whether it yields one clip or
 * five, which is the whole reason this returns a list: paying 60k tokens to
 * read the thing and then taking a single clip out of it was waste.
 */
export async function chooseSegments(
  accountId: string,
  cues: Cue[],
  sourceTitle: string,
  cap: number,
): Promise<SegmentChoice> {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) throw new Error(`No account ${accountId}`);

  const profile = db
    .select()
    .from(contentProfiles)
    .where(eq(contentProfiles.accountId, accountId))
    .get();

  const analysis = latestAnalysis(accountId);
  let evidence = "";
  if (analysis?.rawAnalysis) {
    try {
      const parsed = JSON.parse(analysis.rawAnalysis) as {
        read?: { summary?: string; whatWorks?: string[]; whatToFix?: string[] };
        stats?: { durationStats?: Array<{ label: string; medianViews: number; n: number }> };
      };
      const lines: string[] = [];
      if (parsed.read?.summary) lines.push(parsed.read.summary);
      if (parsed.read?.whatWorks?.length) {
        lines.push("", "What works on this account:");
        for (const w of parsed.read.whatWorks) lines.push(`- ${w}`);
      }
      if (parsed.read?.whatToFix?.length) {
        lines.push("", "What to avoid:");
        for (const w of parsed.read.whatToFix) lines.push(`- ${w}`);
      }
      // Length is deliberately left out: the owner sets it (CLIP_MIN_SEC and
      // CLIP_MAX_SEC), and the account's length stats would argue with that.
      evidence = lines.join("\n");
    } catch {
      evidence = "";
    }
  }

  const lengthWindow = sourceWindowSec();

  const response = await anthropic().messages.create({
    model: MODELS.strategy,
    // Five segments each carry a hook, a caption, hashtags, a quote and a
    // justification, and adaptive thinking draws from the same budget. The old
    // 4000 was sized for one segment and would truncate the tool call - which
    // surfaces as a source that mysteriously declines rather than as an error.
    max_tokens: 12000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    system:
      "You cut short vertical videos for one TikTok account from long source footage. " +
      "You are given a timestamped transcript. Find every self-contained story beat in it " +
      "that is worth posting on its own, or return none. Returning none is correct far more " +
      "often than not, and returning fewer than the cap is normal - a long podcast is mostly " +
      "conversation that does not stand alone. Never pad the list to reach the cap: a weak " +
      "fourth clip costs the account more than it earns. Segments must not overlap. " +
      "Timestamps must come from the transcript, never estimated.",
    tools: [PICK_TOOL],
    tool_choice: { type: "tool", name: "choose_segments" },
    messages: [
      {
        role: "user",
        content: [
          `Account: @${account.handle} - ${account.niche}`,
          profile?.description ? `Format: ${profile.description}` : "",
          profile?.toneOfVoice ? `Tone: ${profile.toneOfVoice}` : "",
          "",
          evidence ? `EVIDENCE FROM THIS ACCOUNT'S OWN PERFORMANCE\n${evidence}` : "",
          "",
          `SOURCE: ${sourceTitle}`,
          "",
          "TRANSCRIPT",
          renderTranscript(cues),
          "",
          cap === 1
            ? "Return only the single best segment, or none if nothing is good enough. Requirements:"
            : `Return every segment worth cutting, best first, up to ${cap}. Fewer is expected; none is a valid answer. Requirements:`,
          "- Each must be a complete story or anecdote: a setup and a payoff, understandable with no context.",
          "- Each must stand alone. They get posted on separate days, so none may depend on another.",
          "- Segments must not overlap, and must not be two tellings of the same story.",
          `- Each segment must run ${lengthWindow.minSec}-${lengthWindow.maxSec} seconds from start to end. If the story is told faster, start earlier so its setup is included; if it cannot be told in that time, it is not usable. Never end before the payoff.`,
          "- start and end are [MM:SS] stamps copied exactly from transcript lines, and quote is the first words spoken at start, copied exactly.",
          "- Start a beat before the first words so it does not open mid-syllable.",
          "- The caption must be a story premise, not a topic label.",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });

  const block = response.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    return { reason: "The model returned no decision.", segments: [] };
  }

  const choice = block.input as { reason?: string; segments?: SegmentInput[] };
  const proposed = (choice.segments ?? []).flatMap((s) => {
    const startSec = parseStamp(s.start);
    const endSec = parseStamp(s.end);
    if (startSec === null || endSec === null) return [];
    return [anchorToQuote({ ...s, startSec, endSec }, cues)];
  });
  const segments = pruneSegments(proposed, cap, lengthWindow);

  // Without this, a beat dropped for its length reads as the model finding
  // nothing, and the owner is told the source was empty when it was not.
  const reason =
    proposed.length > 0 && segments.length === 0
      ? `${choice.reason ?? ""} (Every beat found ran outside ${lengthWindow.minSec}-${lengthWindow.maxSec}s, so none was cut.)`.trim()
      : (choice.reason ?? "");

  return { reason, segments };
}

/* ------------------------------------------------------------------ */
/* Treatment - how the chosen segment should look                      */
/* ------------------------------------------------------------------ */

const TREAT_TOOL: Anthropic.Tool = {
  name: "treat_segment",
  description:
    "Choose the on-screen treatment for this segment, and which spoken words - if any - earn a visual effect.",
  input_schema: {
    type: "object",
    properties: {
      grade: {
        type: "string",
        enum: ["cold", "warm", "none"],
        description:
          "The colour grade. none leaves the footage alone and is the right answer most of the time. cold suits something grim or clinical, warm something human. There is no archive option here: this is modern interview footage and a film grade on it looks pasted on.",
      },
      accent: {
        type: "string",
        description:
          "Hex colour for the active caption word, e.g. '#E0A526'. Pick something that stays legible over this footage.",
      },
      hookExit: {
        type: "number",
        description:
          "Seconds the hook text holds before leaving. 1.5-3. It must leave - a hook that stays is the loudest sign a video was generated.",
      },
      vignette: {
        type: "boolean",
        description: "Darkened edges. Helps hold the eye on a face; wrong on an already-dark shot.",
      },
      hits: {
        type: "array",
        description:
          "Words that earn a visual effect. USUALLY EMPTY OR NEARLY SO. This is a person talking, not action footage - an effect fires only where the story genuinely lands a blow, and 0-3 across a whole clip is normal. Firing them on ordinary words is the fastest way to make this look automated.",
        items: {
          type: "object",
          properties: {
            line: { type: "number", description: "The line index the word appears in." },
            word: {
              type: "string",
              description: "The exact word from that line to fire on.",
            },
            effect: {
              type: "string",
              enum: ["shake", "flash", "punch", "rumble", "drop", "glitch"],
              description:
                "punch is a hard zoom for a single decisive word and is the safest choice over a face. shake suits an impact being described, rumble something approaching, drop a loss, flash a detonation, glitch something going wrong.",
            },
            intensity: {
              type: "number",
              description: "0.3 quiet, 1 full force. Over a talking head, stay below 0.7.",
            },
          },
          required: ["line", "word", "effect", "intensity"],
          additionalProperties: false,
        },
      },
      reasoning: {
        type: "string",
        description: "One or two sentences on why this treatment suits this particular segment.",
      },
    },
    required: ["grade", "accent", "hookExit", "vignette", "hits", "reasoning"],
    additionalProperties: false,
  },
};

/**
 * Decides how one segment should look, and where the picture should react.
 *
 * The podcast path used to render every clip with the same hardcoded look and
 * no effects at all, which made it the most template-driven thing in the
 * pipeline - on the format that performs best. This is the same per-clip
 * decision the narrated path has always made, asked about real speech.
 */
export async function treatSegment(
  accountId: string,
  lines: TranscriptLine[],
  sourceTitle: string,
  hookText: string,
): Promise<{ look: Look; hits: EffectHit[]; reasoning: string }> {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();

  const fallback = {
    look: { ...DEFAULT_LOOK, grade: "none" as const, chrome: [], hookExit: 2.2 },
    hits: [] as EffectHit[],
    reasoning: "",
  };

  if (lines.length === 0) return fallback;

  try {
    const response = await anthropic().messages.create({
      model: MODELS.strategy,
      max_tokens: 3000,
      system:
        "You are treating one short vertical clip cut from a filmed interview. The picture is a " +
        "person talking, and their own voice is the audio - there is no narration. Restraint is " +
        "the whole job: the footage is somebody telling a story, and anything laid over it that " +
        "the story did not earn reads as decoration. Effects on ordinary words are worse than " +
        "no effects at all.",
      tools: [TREAT_TOOL],
      tool_choice: { type: "tool", name: "treat_segment" },
      messages: [
        {
          role: "user",
          content: [
            account ? `Account: @${account.handle} - ${account.niche}` : "",
            `Source: ${sourceTitle}`,
            hookText ? `On-screen hook: ${hookText}` : "",
            "",
            "WHAT IS SAID, line by line",
            renderSentences(lines),
            "",
            "Choose the treatment. Remember that most clips want no effects at all.",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    });

    const block = response.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") return fallback;

    const input = block.input as {
      grade?: string;
      accent?: string;
      hookExit?: number;
      vignette?: boolean;
      hits?: EffectHit[];
      reasoning?: string;
    };

    // normaliseLook clamps anything invented; chrome stays empty because film
    // chrome over a modern interview is exactly the mismatch this avoids.
    const look = normaliseLook({
      captions: "kinetic",
      hookExit: input.hookExit,
      accent: input.accent,
      grade: input.grade,
      chrome: [],
      motion: { lightLeak: false, vignette: input.vignette ?? true, speedRamp: false },
    });

    return {
      look,
      hits: Array.isArray(input.hits) ? input.hits.slice(0, 6) : [],
      reasoning: input.reasoning ?? "",
    };
  } catch {
    // A treatment is an improvement, not a requirement. Losing it should never
    // cost a clip that is otherwise ready to render.
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* Full pipeline                                                       */
/* ------------------------------------------------------------------ */

function setStatus(clipId: string, status: string, fields: Record<string, unknown> = {}) {
  db.update(clips)
    .set({ status: status as never, ...fields })
    .where(eq(clips.id, clipId))
    .run();
}

/**
 * Reads a source once and turns every beat worth keeping into its own clip.
 *
 * Order matters: transcript, then choose, then download. A source the agent
 * declines never costs a download.
 *
 * The first chosen beat is cut into this row. The rest become sibling rows
 * carrying their own decision, queued back through here - and a row that
 * arrives already decided skips straight to cutting, because the source was
 * read when its sibling was chosen and reading it again would pay twice for
 * the same answer.
 */
export async function makeClip(accountId: string, clipId: string) {
  const clip = db.select().from(clips).where(eq(clips.id, clipId)).get();
  if (!clip) throw new Error(`No clip ${clipId}`);

  if (clip.startSec !== null && clip.endSec !== null) {
    await cutClip(accountId, clipId);
    return;
  }

  try {
    // 1. Establish what the URL is before spending anything on it.
    // A stream that is still going out has no duration and no caption track,
    // so without this every later step fails in a way that reads like a broken
    // source rather than a stream that simply has not finished yet.
    setStatus(clipId, "transcribing");
    noteProgress(clipId, "Checking the source");
    const info = await probeSource(clip.sourceUrl);

    if (info?.isLive) {
      setStatus(clipId, "failed", {
        sourceTitle: info.title,
        sourceUploader: info.uploader,
        error:
          "This stream is still live. A live stream carries no captions and cannot be cut " +
          "by timestamp, so there is nothing to read yet. Send the same link once the stream " +
          "has ended and YouTube has published the replay - usually within a few hours - and " +
          "it will cut normally.",
      });
      logEvent({
        accountId,
        level: "warn",
        type: "clip.still_live",
        message: `${clip.sourceUrl} is still streaming - nothing to cut until the replay exists`,
      });
      return;
    }

    // 2. Transcript, without touching the video.
    noteProgress(clipId, "Fetching the captions - reading before downloading anything");
    const transcript = await fetchTranscript(clip.sourceUrl, clipId);

    if (!transcript) {
      // A stream that ended recently is a different problem from a video that
      // never had captions: the captions are coming, just not yet.
      const error = info?.wasLive
        ? "This replay has no captions yet. YouTube generates them for a finished stream " +
          "some hours after it ends. Send the link again later."
        : "This video has no captions, so there is no transcript to read. Pick a source with subtitles, or give timestamps yourself.";

      setStatus(clipId, "failed", {
        sourceTitle: info?.title,
        sourceUploader: info?.uploader,
        error,
      });
      logEvent({
        accountId,
        level: "warn",
        type: "clip.no_captions",
        message: `No captions on ${clip.sourceUrl}`,
      });
      return;
    }

    setStatus(clipId, "choosing", {
      sourceTitle: transcript.title,
      sourceDurationSec: transcript.durationSec,
      transcript: renderTranscript(transcript.cues),
    });

    // 3. Let the agent choose - or decline.
    const cap = segmentCap(transcript.durationSec);
    noteProgress(
      clipId,
      `Reading ${transcript.cues.length} lines of transcript from "${transcript.title}" for up to ${cap} story beat${cap === 1 ? "" : "s"}`,
    );
    const choice = await chooseSegments(accountId, transcript.cues, transcript.title, cap);

    if (choice.segments.length === 0) {
      setStatus(clipId, "declined", { rationale: choice.reason });
      logEvent({
        accountId,
        level: "info",
        type: "clip.declined",
        message: `Nothing worth cutting in "${transcript.title}": ${choice.reason}`,
      });
      return;
    }

    // 4. Fan out. This row takes the first beat; each of the rest becomes its
    // own row carrying the decision already made for it, so the source is read
    // once no matter how many clips come out of it.
    const [first, ...rest] = choice.segments;
    const rendered = renderTranscript(transcript.cues);

    for (const segment of rest) {
      const sibling = db
        .insert(clips)
        .values({
          accountId,
          sourceType: clip.sourceType,
          sourceUrl: clip.sourceUrl,
          sourceTitle: transcript.title,
          sourceDurationSec: transcript.durationSec,
          transcript: rendered,
          startSec: segment.startSec,
          endSec: segment.endSec,
          hookText: segment.hookText ?? "",
          caption: segment.caption ?? "",
          hashtags: JSON.stringify(segment.hashtags ?? []),
          rationale: segment.reason,
          quote: segment.quote ?? null,
        })
        .returning()
        .get();

      enqueue({ accountId, type: "make_clip", payload: { clipId: sibling.id } });
    }

    setStatus(clipId, "downloading", {
      startSec: first.startSec,
      endSec: first.endSec,
      hookText: first.hookText ?? "",
      caption: first.caption ?? "",
      hashtags: JSON.stringify(first.hashtags ?? []),
      rationale: first.reason,
      quote: first.quote ?? null,
    });

    logEvent({
      accountId,
      level: "info",
      type: "clip.chosen",
      message:
        rest.length > 0
          ? `${choice.segments.length} beats worth cutting in "${transcript.title}" - cutting the first, queued ${rest.length} more`
          : `One beat worth cutting in "${transcript.title}"`,
    });

    if (rest.length > 0) {
      noteProgress(clipId, `Found ${choice.segments.length} beats - the other ${rest.length} are queued as their own clips`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus(clipId, "failed", { error: message });
    logEvent({
      accountId,
      level: "error",
      type: "clip.failed",
      message,
    });
    throw err;
  }

  // Cutting is a step of its own, with its own failure handling. It is also
  // exactly what a sibling row does when it comes back through here already
  // decided, which is why it lives outside the block above.
  await cutClip(accountId, clipId);
}

/**
 * Cuts the beat already chosen for a clip into a finished 1080x1920 MP4.
 *
 * Reads the decision off the row rather than taking it as an argument. That is
 * what lets a sibling from a fan-out be produced later, in a separate job,
 * without the source being read or judged a second time.
 */
export async function cutClip(accountId: string, clipId: string) {
  const clip = db.select().from(clips).where(eq(clips.id, clipId)).get();
  if (!clip) throw new Error(`No clip ${clipId}`);
  if (clip.startSec === null || clip.endSec === null) {
    throw new Error(`Clip ${clipId} has no chosen segment to cut`);
  }

  const startSec = Math.max(0, clip.startSec);
  const durationSec = Math.max(3, clip.endSec - startSec);
  const title = clip.sourceTitle ?? clip.sourceUrl;

  try {
    setStatus(clipId, "downloading");

    // The captions again, rather than the rendered transcript on the row: they
    // are kilobytes, and they carry the exact word timings the burned-in
    // captions are cut against, which the rendered text has already rounded away.
    const transcript = await fetchTranscript(clip.sourceUrl, clipId);

    // Only worth paying for the video now, and only for the part that was
    // chosen. Fetching the whole source and then cutting nothing out of it is
    // what made a two-hour podcast render as two hours of footage with
    // captions timed to a segment that was never on screen.
    noteProgress(clipId, `Downloading ${Math.round(durationSec)}s from ${Math.round(startSec)}s in`);
    const dl = await downloadVideo(clip.sourceUrl, clipId, {
      section: { startSec, durationSec },
    });

    setStatus(clipId, "editing", {
      rawPath: dl.path,
      sourceUploader: dl.uploader,
    });

    // After Effects makes its own cut, captions, treatments and sound, so
    // everything below - sentence cuts, the treatment pass, sound design, the
    // Remotion render - is the other backend's version of the same decisions
    // and does not run. The editor needs the segment itself, with the
    // speaker's own audio in it.
    if (useAeEditor()) {
      const lengthSec = (await probe(dl.path)).durationSec || durationSec;
      const payload: AeEditPayload = {
        clipId,
        sourcePath: dl.path,
        targetSec: aeTargetSec(lengthSec),
      };
      enqueue({ accountId, type: "edit_ae", payload });
      noteProgress(clipId, `Downloaded ${Math.round(lengthSec)}s - queued for the After Effects editor`);
      return;
    }

    // Caption and cut.
    // The speaker is the audio, so there is no narration to add - the source
    // audio is kept instead. Grouping the caption words into sentences is what
    // gives the rest of this step something to work against: the captions read
    // three words at a time instead of one, the cuts land where the speaker
    // stops, and an effect can name a word in a line.
    const { words, lines } = transcript
      ? toSentences(transcript.cues, startSec, startSec + durationSec)
      : { words: [], lines: [] };

    // The segment is already trimmed, so shot timings are relative to it.
    const trimmed = (await probe(dl.path)).durationSec || durationSec;
    const planned = sentenceCuts(lines, trimmed);

    // How this particular clip should look, and where - if anywhere - the
    // picture should react to what is being said.
    const treatment = await treatSegment(accountId, lines, title, clip.hookText ?? "");
    const hits = resolveHits(treatment.hits, words);

    // Sound on the cuts and on the hits. Quieter than the narrated path by a
    // deliberate margin: there the mix is built around a synthetic voice, here
    // the speaker's own audio is the subject and an effect over it is
    // punctuation. Only whip and zoom transitions carry a sound at all, so on
    // a typical clip this is two or three noises, not one per cut.
    const sfx = planSoundDesign(
      planned.map((s) => ({ transition: s.transition, startMs: s.startMs })),
      hits,
      clipId,
    ).map((s) => ({ path: s.file, atMs: s.atMs, gain: s.gain * SOURCE_AUDIO_SFX_GAIN }));

    noteProgress(
      clipId,
      `Cutting into ${planned.length} shots on sentence boundaries, ${words.length} captions in ${lines.length} lines` +
        (hits.length > 0 ? `, ${hits.length} effect${hits.length === 1 ? "" : "s"}` : "") +
        (sfx.length > 0 ? `, ${sfx.length} sound cue${sfx.length === 1 ? "" : "s"}` : ""),
    );
    if (treatment.reasoning) noteProgress(clipId, `Treatment: ${treatment.reasoning}`);

    const fetched = await fetchShots(clip.sourceUrl, clipId, planned, {
      localFile: dl.path,
      keepAudio: true,
      // A filmed interview is a locked-off camera on a lit face against a dark
      // set. The archive-film checks read that as a held title card and throw
      // every shot away.
      allowStatic: true,
    });

    const shots = planned
      .map((shot, i) => {
        const file = fetched[i]?.path;
        return file
          ? {
              path: file,
              startMs: shot.startMs,
              endMs: shot.endMs,
              move: shot.move,
              transition: shot.transition,
              transitionMs: shot.transitionMs,
            }
          : null;
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);

    if (shots.length === 0) throw new Error("The chosen segment could not be cut.");

    const outputPath = await renderClip(clipId, {
      shots,
      words,
      lines,
      hookText: clip.hookText ?? "",
      durationMs: trimmed * 1000,
      hits,
      sfx,
      look: treatment.look,
    });
    const edited = { path: outputPath, probe: await probe(outputPath) };

    const thumb = await extractThumbnail(edited.path, clipId);

    setStatus(clipId, "ready", {
      outputPath: edited.path,
      thumbnailPath: thumb,
      outputDurationSec: edited.probe.durationSec,
      sizeBytes: edited.probe.sizeBytes,
      error: null,
    });

    logEvent({
      accountId,
      level: "success",
      type: "clip.ready",
      message: `Cut ${edited.probe.durationSec.toFixed(0)}s from "${title}" - ${clip.hookText ?? ""}`,
    });
    noteProgress(clipId, `Done - ${Math.round(edited.probe.durationSec)}s, ready to download`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus(clipId, "failed", { error: message });
    logEvent({
      accountId,
      level: "error",
      type: "clip.failed",
      message,
    });
    throw err;
  }
}

/**
 * How far the sound-effect gains are pulled back on a clip that keeps its
 * source audio. The narrated path mixes against a synthetic voice it controls;
 * here the speaker is already at full level and everything else is punctuation.
 */
const SOURCE_AUDIO_SFX_GAIN = 0.55;

/** Camera moves, cycled so no two consecutive shots share one. */
const MOVES: Move[] = ["push", "hold", "punch", "pull", "driftL", "hold", "push", "driftR"];
/**
 * A talking head is one continuous take, so the blends stay short and mostly
 * hard - a long dissolve on the same face reads as a mistake.
 */
const BLENDS: Transition[] = ["cut", "cut", "whipL", "cut", "glide", "cut", "whipR", "cut"];

/**
 * Splits a segment into shots that change when the speaker changes thought.
 *
 * The old version divided the runtime by four. That put cuts in the middle of
 * sentences at random, which is the one place an edit must never cut: the
 * viewer hears a break that the picture does not explain. Sentence boundaries
 * are already known - the transcript carries them - so the cut lands where the
 * speaker actually stops.
 *
 * Shots still target about four seconds. The difference is that the boundary
 * is negotiated with the speech rather than imposed on it.
 */
export function sentenceCuts(
  lines: TranscriptLine[],
  durationSec: number,
): Array<{
  atSec: number;
  startMs: number;
  endMs: number;
  move: Move;
  transition: Transition;
  transitionMs: number;
}> {
  if (lines.length === 0) return jumpCuts(durationSec);

  const totalMs = durationSec * 1000;
  const TARGET_MS = 4000;
  // Never let a shot run so long the frame goes dead, nor so short it flicks.
  const MAX_MS = 6500;
  const MIN_MS = 1800;

  // 1. Gather sentences into shots of roughly the target length.
  const bounds: Array<{ startMs: number; endMs: number }> = [];
  let openedAt = 0;

  for (let i = 0; i < lines.length; i++) {
    const nextStart = i + 1 < lines.length ? lines[i + 1].startMs : totalMs;
    const span = nextStart - openedAt;
    const isLast = i + 1 >= lines.length;

    if (span >= TARGET_MS || span >= MAX_MS || isLast) {
      bounds.push({ startMs: openedAt, endMs: isLast ? totalMs : nextStart });
      openedAt = nextStart;
    }
  }

  // 2. Fold anything too short into its neighbour, so a one-word sentence does
  // not become a shot of its own.
  const merged: Array<{ startMs: number; endMs: number }> = [];
  for (const b of bounds) {
    const last = merged[merged.length - 1];
    if (last && b.endMs - b.startMs < MIN_MS) {
      last.endMs = b.endMs;
    } else {
      merged.push({ ...b });
    }
  }
  if (merged.length === 0) return jumpCuts(durationSec);

  // 3. A single sentence can run longer than any shot should. Cutting inside
  // one is not the thing this function exists to avoid - that was cutting at
  // arbitrary points regardless of the speech. Holding one frame for twelve
  // seconds because the speaker did not pause is its own failure, so an
  // over-long span is divided evenly instead.
  const split: Array<{ startMs: number; endMs: number }> = [];
  for (const b of merged) {
    const span = b.endMs - b.startMs;
    const parts = Math.ceil(span / MAX_MS);
    if (parts <= 1) {
      split.push(b);
      continue;
    }
    const each = span / parts;
    for (let k = 0; k < parts; k++) {
      split.push({ startMs: b.startMs + k * each, endMs: b.startMs + (k + 1) * each });
    }
  }

  // The first shot has nothing to arrive over, so it always cuts.
  return split.map((b, i) => {
    const transition = i === 0 ? "cut" : BLENDS[i % BLENDS.length];
    return {
      atSec: b.startMs / 1000,
      startMs: b.startMs,
      endMs: b.endMs,
      move: MOVES[i % MOVES.length],
      transition,
      transitionMs: transition === "cut" ? 0 : transition === "glide" ? 420 : 240,
    };
  });
}

/**
 * Splits a talking-head segment into jump cuts on a timer.
 *
 * The fallback for a segment with no usable sentence boundaries - a source
 * whose captions could not be fetched a second time. Cutting on a metronome is
 * worse than cutting on speech, but it is much better than one locked-off
 * frame for forty seconds.
 */
function jumpCuts(
  durationSec: number,
): Array<{
  atSec: number;
  startMs: number;
  endMs: number;
  move: Move;
  transition: Transition;
  transitionMs: number;
}> {
  // Around four seconds a shot: short enough to stay alive, long enough that
  // the viewer is not being shaken.
  const count = Math.max(1, Math.min(MOVES.length, Math.round(durationSec / 4)));
  const each = durationSec / count;

  return Array.from({ length: count }, (_, i) => {
    const transition = i === 0 ? "cut" : BLENDS[i % BLENDS.length];
    return {
      atSec: i * each,
      startMs: i * each * 1000,
      endMs: (i + 1) * each * 1000,
      move: MOVES[i % MOVES.length],
      transition,
      transitionMs: transition === "cut" ? 0 : transition === "glide" ? 420 : 240,
    };
  });
}

/** Deletes a clip's files from disk. The row keeps the decision for reference. */
export function discardClipFiles(clipId: string) {
  const clip = db.select().from(clips).where(eq(clips.id, clipId)).get();
  if (!clip) return;
  for (const p of [clip.rawPath, clip.outputPath, clip.thumbnailPath]) {
    if (p && fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        // A locked file is not worth failing the request over.
      }
    }
  }
  db.update(clips)
    .set({ rawPath: null, outputPath: null, thumbnailPath: null })
    .where(eq(clips.id, clipId))
    .run();
}
