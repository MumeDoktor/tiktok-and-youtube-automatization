/**
 * Finding a source to cut, without being handed one.
 *
 * The rest of the pipeline starts from a URL somebody pasted. This is what
 * produces that URL on its own: the agent works out what this account should
 * be cutting from, searches for it, and checks the shortlist is actually
 * usable before anything downstream commits to it.
 *
 * Three steps, cheapest first - propose queries, search, then verify captions
 * on a shortlist only. Captions cost a call per video, so they are checked
 * last and only on candidates already judged worth it.
 */
import { desc, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "@/db";
import { accounts, clips, contentProfiles } from "@/db/schema";
import { anthropic } from "@/lib/anthropic";
import { MODELS } from "@/lib/env";
import {
  hasCaptions,
  searchYouTube,
  MAX_SOURCE_SEC,
  MIN_SOURCE_SEC,
  type YouTubeResult,
} from "@/lib/youtube";
import { latestAnalysis } from "./account-analysis";
import { logEvent } from "./events";

/** How many searches one decision is allowed to run. */
const MAX_QUERIES = 4;
/** How many candidates to pay a caption check for before giving up. */
const MAX_CAPTION_CHECKS = 4;

const QUERY_TOOL: Anthropic.Tool = {
  name: "propose_queries",
  description:
    "Propose the YouTube searches most likely to surface long-form interviews worth cutting for this account.",
  input_schema: {
    type: "object",
    properties: {
      reasoning: {
        type: "string",
        description:
          "Why these searches, from what performs on this account. Two or three sentences.",
      },
      queries: {
        type: "array",
        items: { type: "string" },
        description:
          `Up to ${MAX_QUERIES} search strings, as a person would type them into YouTube. ` +
          "Aim at long-form interviews and podcasts where someone tells first-hand stories, " +
          "because that is what can be cut into a clip carrying a real voice. " +
          "Vary them - four wordings of one search returns one set of results.",
      },
    },
    required: ["reasoning", "queries"],
    additionalProperties: false,
  },
};

const PICK_TOOL: Anthropic.Tool = {
  name: "pick_source",
  description:
    "Choose which of these candidates to read for clips, in order of preference, or none if none of them fit.",
  input_schema: {
    type: "object",
    properties: {
      reasoning: {
        type: "string",
        description:
          "Why this order. If nothing fits, say plainly what is wrong with the whole list.",
      },
      ranked: {
        type: "array",
        items: { type: "string" },
        description:
          "Candidate ids, best first. Empty is valid. Only ids from the list given to you.",
      },
    },
    required: ["reasoning", "ranked"],
    additionalProperties: false,
  },
};

/** A video already decided on, for the search to aim at instead of choosing its own. */
export type SourceHint = { angle: string; searchTerms: string };

export type SourcePick = {
  url: string;
  title: string;
  uploader: string | null;
  durationSec: number;
  /** Why this source, for the owner to read. */
  why: string;
};

/** The account's own evidence, rendered for a prompt. Empty when never analysed. */
function evidenceFor(accountId: string): string {
  const analysis = latestAnalysis(accountId);
  if (!analysis?.rawAnalysis) return "";

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
    if (parsed.stats?.durationStats?.length) {
      lines.push("", "Length vs median views:");
      for (const d of parsed.stats.durationStats) {
        lines.push(`- ${d.label}: ${d.medianViews.toLocaleString()} median (n=${d.n})`);
      }
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

/** Sources already cut for this account, so the same one is not mined twice. */
function alreadyUsed(accountId: string): Set<string> {
  // A clip that FAILED says nothing about the source - it was a download that
  // broke or a call that errored. Letting those block the source forever means
  // one transient fault permanently burns the best interview on the list.
  // A declined source is different: it was read, and judged empty.
  const rows = db
    .select({ url: clips.sourceUrl, status: clips.status })
    .from(clips)
    .where(eq(clips.accountId, accountId))
    .orderBy(desc(clips.createdAt))
    .limit(200)
    .all()
    .filter((r) => r.status !== "failed");

  const used = new Set<string>();
  for (const r of rows) {
    if (!r.url) continue;
    used.add(r.url);
    // Stored URLs are the canonical watch form, but a source can arrive as a
    // shorts or youtu.be link, so match on the id too.
    const id = r.url.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/)?.[1];
    if (id) used.add(id);
  }
  return used;
}

/** Asks what this account should be searching for. */
async function proposeQueries(
  accountId: string,
  hint?: SourceHint,
): Promise<{ reasoning: string; queries: string[] }> {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) throw new Error(`No account ${accountId}`);

  const profile = db
    .select()
    .from(contentProfiles)
    .where(eq(contentProfiles.accountId, accountId))
    .get();

  const evidence = evidenceFor(accountId);

  const recent = db
    .select({ title: clips.sourceTitle })
    .from(clips)
    .where(eq(clips.accountId, accountId))
    .orderBy(desc(clips.createdAt))
    .limit(15)
    .all()
    .map((r) => r.title)
    .filter(Boolean);

  const response = await anthropic().messages.create({
    model: MODELS.strategy,
    max_tokens: 2000,
    system:
      "You find source material for one TikTok account. You are looking for long-form " +
      "interviews and podcasts on YouTube that contain first-hand stories, because a clip " +
      "cut from one carries the speaker's real voice rather than narration over stock " +
      "footage. Write searches a person would actually type, not keyword soup.",
    tools: [QUERY_TOOL],
    tool_choice: { type: "tool", name: "propose_queries" },
    messages: [
      {
        role: "user",
        content: [
          `Account: @${account.handle} - ${account.niche}`,
          profile?.description ? `Format: ${profile.description}` : "",
          "",
          evidence ? `EVIDENCE FROM THIS ACCOUNT'S OWN PERFORMANCE\n${evidence}` : "",
          "",
          recent.length
            ? `ALREADY MINED (search for something else):\n${recent.map((t) => `- ${t}`).join("\n")}`
            : "",
          "",
          hint
            ? `THE VIDEO ALREADY DECIDED ON\n${hint.angle}\nFind interviews where this is told first-hand. A starting search: ${hint.searchTerms}`
            : "",
          "",
          hint
            ? `Propose up to ${MAX_QUERIES} YouTube searches for long interviews where this story is told.`
            : `Propose up to ${MAX_QUERIES} YouTube searches for interviews worth cutting for this account.`,
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });

  const block = response.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") return { reasoning: "", queries: [] };

  const input = block.input as { reasoning?: string; queries?: string[] };
  return {
    reasoning: input.reasoning ?? "",
    queries: (input.queries ?? []).slice(0, MAX_QUERIES),
  };
}

/** Asks which of the candidates to read, best first. */
async function rankCandidates(
  accountId: string,
  candidates: YouTubeResult[],
  hint?: SourceHint,
): Promise<{ reasoning: string; ranked: string[] }> {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) throw new Error(`No account ${accountId}`);

  const response = await anthropic().messages.create({
    model: MODELS.strategy,
    max_tokens: 3000,
    system:
      "You choose which long-form interview to mine for short clips for one TikTok account. " +
      "You are judging from titles and channels only - you have not heard any of them - so " +
      "prefer sources whose title names a person and a first-hand experience over ones that " +
      "name a topic. Say so honestly when the whole list looks weak.",
    tools: [PICK_TOOL],
    tool_choice: { type: "tool", name: "pick_source" },
    messages: [
      {
        role: "user",
        content: [
          `Account: @${account.handle} - ${account.niche}`,
          hint ? `Looking for an interview where this is told: ${hint.angle}` : "",
          "",
          "CANDIDATES",
          ...candidates.map(
            (c) =>
              `id=${c.id} | ${Math.round((c.durationSec ?? 0) / 60)}min | ${c.uploader ?? "unknown"} | ${c.title}`,
          ),
          "",
          "Rank the ones worth reading, best first. Ranking none is valid.",
        ].join("\n"),
      },
    ],
  });

  const block = response.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") return { reasoning: "", ranked: [] };

  const input = block.input as { reasoning?: string; ranked?: string[] };
  return { reasoning: input.reasoning ?? "", ranked: input.ranked ?? [] };
}

/**
 * Finds one source worth cutting, or nothing.
 *
 * Returning null is a real answer, not a failure - a search that surfaces
 * nothing usable is better than committing the pipeline to a bad source.
 */
export async function findSource(
  accountId: string,
  hint?: SourceHint,
  /** URLs already read in this request, which the stored clips do not know about yet. */
  exclude: string[] = [],
): Promise<SourcePick | null> {
  const proposed = await proposeQueries(accountId, hint);
  const reasoning = proposed.reasoning;
  // The decided search goes first: it was written knowing why this video was chosen.
  const queries = hint?.searchTerms
    ? [...new Set([hint.searchTerms, ...proposed.queries])].slice(0, MAX_QUERIES)
    : proposed.queries;

  if (queries.length === 0) {
    logEvent({
      accountId,
      level: "warn",
      type: "source.no_queries",
      message: "The agent proposed no searches to run.",
    });
    return null;
  }

  logEvent({
    accountId,
    type: "source.searching",
    message: `Searching YouTube: ${queries.join(" · ")}`,
    meta: { reasoning, queries },
  });

  // Merge every query's results, keeping the first sighting of each video.
  const used = alreadyUsed(accountId);
  for (const url of exclude) {
    used.add(url);
    const id = url.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/)?.[1];
    if (id) used.add(id);
  }
  const byId = new Map<string, YouTubeResult>();

  for (const query of queries) {
    for (const r of await searchYouTube(query, { limit: 10 })) {
      if (used.has(r.id) || used.has(r.url) || byId.has(r.id)) continue;
      byId.set(r.id, r);
    }
  }

  const candidates = [...byId.values()];

  if (candidates.length === 0) {
    logEvent({
      accountId,
      level: "warn",
      type: "source.none_found",
      message:
        `No new sources between ${Math.round(MIN_SOURCE_SEC / 60)} and ` +
        `${Math.round(MAX_SOURCE_SEC / 3600)}h for: ${queries.join(" · ")}`,
    });
    return null;
  }

  const { reasoning: pickWhy, ranked } = await rankCandidates(accountId, candidates, hint);

  // Captions are the one thing that makes a source cuttable at all, and the
  // only check here that costs a call per video - so it runs last, in the
  // agent's own order of preference, and stops at the first source that works.
  let checked = 0;
  for (const id of ranked) {
    const candidate = byId.get(id);
    if (!candidate) continue;
    if (checked >= MAX_CAPTION_CHECKS) break;
    checked++;

    if (!(await hasCaptions(candidate.url))) {
      logEvent({
        accountId,
        level: "info",
        type: "source.no_captions",
        message: `Skipping "${candidate.title}" - no captions to read`,
      });
      continue;
    }

    return {
      url: candidate.url,
      title: candidate.title,
      uploader: candidate.uploader,
      durationSec: candidate.durationSec ?? 0,
      why: pickWhy,
    };
  }

  logEvent({
    accountId,
    level: "warn",
    type: "source.none_usable",
    message:
      candidates.length > 0 && ranked.length === 0
        ? `Found ${candidates.length} candidates but the agent rated none worth reading: ${pickWhy}`
        : `Checked ${checked} of ${candidates.length} candidates; none had captions.`,
  });

  return null;
}
