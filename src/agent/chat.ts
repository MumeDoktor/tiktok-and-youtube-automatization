import { asc, desc, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "@/db";
import { agentMemory, chatMessages, clips } from "@/db/schema";
import { anthropic } from "@/lib/anthropic";
import { env, MODELS } from "@/lib/env";
import {
  clearTranscriptFiles,
  fetchTranscript,
  probeSource,
  renderTranscript,
  type Cue,
} from "@/lib/media";
import {
  searchYouTube,
  MAX_SOURCE_SEC,
  MIN_SOURCE_SEC,
} from "@/lib/youtube";
import { searchAllSources } from "./footage";
import { buildAgentContext, renderLivePrompt, renderStablePrompt } from "./context";
import { enqueue, logEvent } from "./events";

/** How many raw turns to replay. Older ones survive as distilled memory. */
const HISTORY_LIMIT = 80;

/** Safety valve on the tool loop. */
const MAX_STEPS = 6;

/**
 * How much of a source's transcript to put in front of the chat agent.
 *
 * Enough to judge what is in a source and propose an angle; far short of the
 * whole thing, because a four-hour podcast is ~60k tokens and this runs inside
 * a conversation that already carries the account's history. The cut itself
 * reads every line - this is only for deciding whether to make the cut.
 */
const TRANSCRIPT_BUDGET = 12_000;

/** How many places across a long source to look at. */
const SAMPLE_WINDOWS = 8;

/**
 * Excerpts a long transcript from evenly spaced points across its length.
 *
 * The first ten minutes of an interview is introductions, so a plain head
 * truncation would say almost nothing about what the source actually holds.
 */
export function sampleTranscript(cues: Cue[], budget: number): string {
  if (cues.length === 0) return "";

  const perWindow = Math.floor(budget / SAMPLE_WINDOWS);
  // Fewer cues than windows would make stride 0 and hand back the same opening
  // eight times over.
  const windows = Math.min(SAMPLE_WINDOWS, cues.length);
  const stride = Math.max(1, Math.floor(cues.length / windows));
  const parts: string[] = [];

  for (let w = 0; w < windows; w++) {
    const from = w * stride;
    let text = "";

    for (let i = from; i < cues.length && text.length < perWindow; i++) {
      text += `${renderTranscript([cues[i]])}\n`;
    }
    if (text.trim()) parts.push(text.trimEnd());
  }

  return parts.join("\n[...]\n");
}

export function loadHistory(accountId: string, limit = HISTORY_LIMIT) {
  const rows = db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.accountId, accountId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(limit)
    .all();
  return rows.reverse();
}

export function loadFullHistory(accountId: string) {
  return db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.accountId, accountId))
    .orderBy(asc(chatMessages.createdAt))
    .all();
}

/* ------------------------------------------------------------------ */
/* Tools the agent can use mid-conversation                            */
/* ------------------------------------------------------------------ */

const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_archive",
    description:
      "Search every public-domain footage source available - the DoD archive and the Internet Archive. Use this before promising a video, to check what footage actually exists. Describe what is ON SCREEN, not the story.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Visual description, e.g. 'F-22 Raptor afterburner takeoff night'.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "find_sources",
    description:
      "Search YouTube for long-form interviews and podcasts worth cutting for this account. " +
      "Use this when the owner wants a video but has not given you a link - it is how you find " +
      "source material yourself instead of asking them for one. Returns candidates with their " +
      "length and channel; propose one, then use make_video with source=url once they agree.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What to search for, as a person would type it into YouTube. Aim at interviews " +
            "where someone tells first-hand stories, e.g. 'delta force operator interview podcast'.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "inspect_source",
    description:
      "Read a video URL the owner pasted: title, uploader, length, and what is actually said in it. " +
      "Use this whenever they give you a link - never ask them to describe their own link, and never " +
      "propose an angle for one you have not read.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The exact URL the owner pasted." },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "make_video",
    description:
      "Produce a finished vertical video. Only call this once the owner has agreed to the idea. Takes a few minutes; the clip appears in their list as it progresses.",
    input_schema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: ["archive", "url"],
          description:
            "archive searches the DoD footage archive. url cuts from a link the owner gave you.",
        },
        query: {
          type: "string",
          description:
            "For archive: what footage to find. For url: a URL you got from find_sources " +
            "or that the owner pasted, copied exactly. NEVER compose, guess or reconstruct a " +
            "URL from a title or a person's name - a made-up link looks valid and fails minutes " +
            "later. If you do not have a real URL in front of you, call find_sources first.",
        },
        hookText: {
          type: "string",
          description:
            "The story, in one line, max ~60 characters. This is what the owner is agreeing to. The final on-screen wording is written later, once the footage has actually been looked at, and will stay on this story.",
        },
        caption: {
          type: "string",
          description: "The TikTok caption. Under 80 characters - a label, not the story.",
        },
        hashtags: { type: "array", items: { type: "string" } },
        why: {
          type: "string",
          description: "One or two sentences on why this video, cited from the account's numbers.",
        },
      },
      required: ["source", "query", "hookText", "caption", "why"],
      additionalProperties: false,
    },
  },
];

type ToolResult = { text: string; note?: string };

async function runTool(
  accountId: string,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  if (name === "search_archive") {
    const query = String(input.query ?? "");
    try {
      const found = await searchAllSources(accountId, query);
      if (found.length === 0) {
        return {
          text:
            `No public-domain footage found for "${query}". Without a DVIDS key only the ` +
            `Internet Archive is searched, and its public-domain collections are mid-century ` +
            `film - modern hardware will not be in there.`,
        };
      }
      return {
        text: found
          .map(
            (c) =>
              `key=${c.key} | ${c.source} | ${c.when} | ${c.title}\n  ${c.description.slice(0, 160)}`,
          )
          .join("\n"),
        note: `searched public-domain archives for "${query}" - ${found.length} results`,
      };
    } catch (err) {
      return {
        text: `Archive search failed: ${err instanceof Error ? err.message : String(err)}`,
        note: "archive search failed",
      };
    }
  }

  if (name === "find_sources") {
    const query = String(input.query ?? "").trim();
    if (!query) return { text: "No search given." };

    try {
      const found = await searchYouTube(query, { limit: 12 });
      if (found.length === 0) {
        return {
          text:
            `Nothing between ${Math.round(MIN_SOURCE_SEC / 60)} minutes and ` +
            `${Math.round(MAX_SOURCE_SEC / 3600)} hours for "${query}". Shorter results are ` +
            `already somebody's edit and have no beat left to find inside them.`,
          note: `searched YouTube for "${query}" - nothing long enough`,
        };
      }

      // Sources already cut for this account are not new material.
      const used = new Set(
        db
          .select({ url: clips.sourceUrl })
          .from(clips)
          .where(eq(clips.accountId, accountId))
          .all()
          .map((r) => r.url)
          .filter(Boolean),
      );

      const fresh = found.filter((r) => !used.has(r.url));

      return {
        text: [
          `${fresh.length} candidate(s) for "${query}":`,
          ...fresh.map(
            (r) =>
              `${r.url} | ${Math.round((r.durationSec ?? 0) / 60)}min | ${r.uploader ?? "unknown"} | ${r.title}`,
          ),
          "",
          "You have not heard any of these - you are reading titles. Use inspect_source on one before promising the owner anything about what is in it.",
        ].join("\n"),
        note: `searched YouTube for "${query}" - ${fresh.length} candidates`,
      };
    } catch (err) {
      return {
        text: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
        note: "youtube search failed",
      };
    }
  }

  if (name === "inspect_source") {
    const url = String(input.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) return { text: "That is not a URL." };

    // Not tied to a clip, so nothing else will ever clean the caption file up.
    const scratchId = `inspect-${Date.now()}`;
    try {
      const info = await probeSource(url);
      if (!info) {
        return {
          text: `Could not read ${url}. It may be private, region-locked, or removed.`,
          note: "could not read the link",
        };
      }

      const head = [
        `title: ${info.title ?? "unknown"}`,
        `uploader: ${info.uploader ?? "unknown"}`,
        `length: ${info.durationSec ? `${Math.round(info.durationSec)}s` : "unknown"}`,
      ].join("\n");

      if (info.isLive) {
        return {
          text: `${head}\n\nThis stream is still live. It has no captions and cannot be cut by timestamp yet - it has to finish and be published as a replay first.`,
          note: `read ${url} - still streaming`,
        };
      }

      const transcript = await fetchTranscript(url, scratchId);
      if (!transcript) {
        return {
          text: `${head}\n\nNo captions on this one, so there is no transcript to read and nothing can be cut from it by timestamp.`,
          note: `read ${url} - no captions`,
        };
      }

      // A short source arrives whole; a long one is sampled across its length,
      // because the head of a four-hour podcast says nothing about the rest.
      const full = renderTranscript(transcript.cues);
      const body =
        full.length <= TRANSCRIPT_BUDGET
          ? full
          : `${sampleTranscript(transcript.cues, TRANSCRIPT_BUDGET)}\n\n[Sampled across the full length. The cut reads every line of it.]`;

      return {
        text: `${head}\n\nWHAT IS SAID\n${body}`,
        note: `read "${info.title ?? url}" - ${Math.round(info.durationSec ?? 0)}s`,
      };
    } catch (err) {
      return {
        text: `Could not read ${url}: ${err instanceof Error ? err.message : String(err)}`,
        note: "could not read the link",
      };
    } finally {
      clearTranscriptFiles(scratchId);
    }
  }

  if (name === "make_video") {
    const source = input.source === "url" ? "url" : "dvids";
    const query = String(input.query ?? "").trim();
    if (!query) return { text: "No source given, nothing queued." };

    // A URL is checked before it is queued. The model knows a great many real
    // stories and can produce a link-shaped string for any of them; such a URL
    // passes every syntactic test and only fails minutes later, inside the
    // worker, after three retries. Resolving it here turns that into a
    // correction the model can act on in this same reply.
    if (source === "url") {
      if (!/^https?:\/\//i.test(query)) {
        return {
          text: `"${query}" is not a URL. Use find_sources to get a real one.`,
          note: "rejected a malformed source",
        };
      }
      const info = await probeSource(query);
      if (!info) {
        return {
          text:
            `That URL does not resolve to a real video: ${query}. ` +
            `Nothing was queued. Do not reconstruct a link from a title or a name - ` +
            `call find_sources and use a URL it returns, verbatim.`,
          note: "rejected an unresolvable source",
        };
      }
      if (info.isLive) {
        return {
          text: `That stream is still live, so it has no captions and cannot be cut yet. Nothing queued.`,
          note: "rejected a live source",
        };
      }
    }

    const clip = db
      .insert(clips)
      .values({
        accountId,
        sourceType: source,
        sourceUrl: query,
        hookText: String(input.hookText ?? ""),
        caption: String(input.caption ?? ""),
        hashtags: JSON.stringify(
          Array.isArray(input.hashtags) ? input.hashtags.map(String) : [],
        ),
        rationale: String(input.why ?? ""),
      })
      .returning()
      .get();

    enqueue({
      accountId,
      type: source === "url" ? "make_clip" : "find_footage",
      payload: { clipId: clip.id },
    });

    logEvent({
      accountId,
      type: "clip.queued_from_chat",
      message: `Queued from chat: ${input.hookText ?? query}`,
    });

    return {
      text:
        `Queued as clip ${clip.id}. It will move through downloading and editing over the next ` +
        `few minutes and then appear as Ready with a download link.`,
      note: `started making the video — "${input.hookText ?? query}"`,
    };
  }

  return { text: `Unknown tool ${name}.` };
}

/* ------------------------------------------------------------------ */
/* Chat                                                                */
/* ------------------------------------------------------------------ */

const CHAT_RULES = [
  "",
  "## Making videos",
  "You can make videos yourself, in this conversation.",
  "- search_archive checks what public-domain footage exists. Use it before promising anything.",
  "- make_video produces the finished vertical clip.",
  "",
  "What make_video actually does, so you describe it honestly: the film is looked at frame",
  "by frame, a narration script is written from what is really on screen, that script is",
  "spoken aloud, and the picture is cut to the voice - about ten shots, each timed to a line,",
  "with word-by-word captions and a hook that leaves after roughly two seconds. It lands at",
  `${env.clipMinSec}-${env.clipMaxSec} seconds, the length the owner has set. It takes about six minutes.`,
  "Do not promise exact on-screen wording. The script is written against the footage after you",
  "hand off; it keeps to the story you agreed but may sharpen the words.",
  "",
  "Propose the idea first and say why, grounded in this account's numbers. Wait for agreement",
  "before calling make_video - do not produce something the owner has not agreed to.",
  "If they clearly ask you to just make it, that is agreement.",
  "",
  "Two footage sources, covering different eras:",
  "- DVIDS: modern US military material. Needs an API key, which may not be configured.",
  "- Internet Archive: public-domain mid-century film. Always available, but nothing recent.",
  "",
  "Neither holds podcast or interview footage. If the owner wants an operator interview clip,",
  "say plainly that these archives cannot supply it and ask them for a source link instead -",
  "make_video with source=url cuts from any link they give you.",
  "Never ship period footage for an angle that needs modern hardware; decline and say why.",
].join("\n");

/**
 * Streams one chat turn, running any tools the agent decides to use, and
 * persists both sides.
 *
 * Awareness comes from three layers stacked in the prompt:
 *   1. standing memory   (distilled directives, never expire)
 *   2. raw history       (last HISTORY_LIMIT turns, verbatim)
 *   3. live account data (metrics, recent posts, clips, market read)
 */
export async function* streamChat(
  accountId: string,
  userMessage: string,
): AsyncGenerator<string, void, unknown> {
  const ctx = await buildAgentContext(accountId);

  db.insert(chatMessages)
    .values({ accountId, role: "user", content: userMessage })
    .run();

  const history = loadHistory(accountId);
  const messages: Anthropic.MessageParam[] = history.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const system: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: renderStablePrompt(ctx) + CHAT_RULES,
      // Stable prefix - cache it so repeat turns only pay for the tail.
      cache_control: { type: "ephemeral" },
    },
    { type: "text", text: renderLivePrompt(ctx) },
  ];

  let visible = "";

  for (let step = 0; step < MAX_STEPS; step++) {
    const stream = anthropic().messages.stream({
      model: MODELS.chat,
      max_tokens: 8000,
      system,
      tools: TOOLS,
      messages,
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        visible += event.delta.text;
        yield event.delta.text;
      }
    }

    const final = await stream.finalMessage();
    const toolUses = final.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (toolUses.length === 0) {
      db.insert(chatMessages)
        .values({
          accountId,
          role: "assistant",
          content: visible,
          inputTokens: final.usage.input_tokens,
          outputTokens: final.usage.output_tokens,
        })
        .run();
      break;
    }

    // Show the owner what is happening rather than a silent pause.
    messages.push({ role: "assistant", content: final.content });
    const results: Anthropic.ToolResultBlockParam[] = [];

    for (const use of toolUses) {
      const result = await runTool(
        accountId,
        use.name,
        (use.input ?? {}) as Record<string, unknown>,
      );
      if (result.note) {
        const line = `\n\n_${result.note}_\n\n`;
        visible += line;
        yield line;
      }
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: result.text,
      });
    }

    messages.push({ role: "user", content: results });

    if (step === MAX_STEPS - 1) {
      db.insert(chatMessages)
        .values({ accountId, role: "assistant", content: visible })
        .run();
    }
  }

  // Distil anything durable out of this exchange. Best-effort: a failure here
  // must not lose the user a reply that already streamed successfully.
  try {
    await extractMemories(accountId, userMessage, visible);
  } catch (err) {
    logEvent({
      accountId,
      level: "warn",
      type: "memory.extract_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/* ------------------------------------------------------------------ */
/* Memory distillation                                                 */
/* ------------------------------------------------------------------ */

const MEMORY_TOOL: Anthropic.Tool = {
  name: "record_memories",
  description:
    "Record durable facts or standing instructions from this exchange. Only record things that should still matter weeks from now.",
  input_schema: {
    type: "object",
    properties: {
      memories: {
        type: "array",
        description:
          "Zero or more durable items. Return an empty array when the exchange was small talk, a one-off question, or purely about numbers already stored elsewhere.",
        items: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["directive", "fact", "preference", "learning"],
              description:
                "directive = a standing instruction to obey; fact = a stable truth about the account or owner; preference = a soft style preference; learning = something proven by results.",
            },
            content: {
              type: "string",
              description:
                "One self-contained sentence, written so it makes sense with no other context.",
            },
          },
          required: ["kind", "content"],
          additionalProperties: false,
        },
      },
    },
    required: ["memories"],
    additionalProperties: false,
  },
};

async function extractMemories(
  accountId: string,
  userMessage: string,
  assistantReply: string,
): Promise<void> {
  const existing = db
    .select()
    .from(agentMemory)
    .where(eq(agentMemory.accountId, accountId))
    .all()
    .filter((m) => m.active)
    .map((m) => m.content);

  const response = await anthropic().messages.create({
    model: MODELS.chat,
    max_tokens: 2000,
    system:
      "You maintain the long-term memory of a TikTok account manager agent. " +
      "Read one exchange between the owner and the agent and record only what should persist. " +
      "Standing instructions, stated goals, brand rules, and hard constraints persist. " +
      "Questions, greetings, and anything already captured in the existing memory list do not. " +
      "Never duplicate an existing memory or restate it in different words.",
    tools: [MEMORY_TOOL],
    tool_choice: { type: "tool", name: "record_memories" },
    messages: [
      {
        role: "user",
        content: [
          existing.length
            ? `Existing memories (do not duplicate):\n${existing.map((m) => `- ${m}`).join("\n")}`
            : "Existing memories: none.",
          "",
          `OWNER SAID:\n${userMessage}`,
          "",
          `AGENT REPLIED:\n${assistantReply}`,
        ].join("\n"),
      },
    ],
  });

  const block = response.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") return;

  const input = block.input as { memories?: Array<{ kind: string; content: string }> };
  const items = input.memories ?? [];
  const valid = new Set(["directive", "fact", "preference", "learning"]);

  for (const item of items) {
    if (!item?.content?.trim()) continue;
    const kind = valid.has(item.kind) ? item.kind : "fact";
    db.insert(agentMemory)
      .values({
        accountId,
        kind: kind as "directive" | "fact" | "preference" | "learning",
        content: item.content.trim(),
        source: "chat",
      })
      .run();
  }

  if (items.length) {
    logEvent({
      accountId,
      level: "info",
      type: "memory.saved",
      message: `Remembered ${items.length} item(s) from chat`,
      meta: { items },
    });
  }
}
