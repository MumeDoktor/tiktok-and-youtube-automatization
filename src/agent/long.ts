import fs from "node:fs";
import path from "node:path";

import { and, desc, eq, ne } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "@/db";
import { accounts, clips, settings } from "@/db/schema";
import { subscriptionMessagesCreate } from "@/lib/claude-subscription";
import { env, MODELS } from "@/lib/env";
import { ensureDirs, extractThumbnail, mediaDir, outDir, probe, run, splitCmd } from "@/lib/media";
import { pickTrack } from "@/lib/music";
import { renderStory, type StoryPlace, type StoryScene } from "@/lib/remotion";
import { telegramVideo } from "@/lib/telegram";
import { speak, type ScriptLine, type VoiceLine } from "@/lib/tts";
import {
  articlePictures,
  commonsPictures,
  downloadPictures,
  findArticle,
  readArticle,
  type Article,
  type Picture,
} from "@/lib/wikipedia";
import { logEvent, noteProgress } from "./events";

/**
 * Long-form video: a 12-16 minute sourced documentary in a 16:9 frame.
 *
 * The first version of this narrated from memory over whatever archive film a
 * search turned up, and the owner rejected it: the screen never showed the
 * thing being talked about, and the script named nobody. The videos that work
 * do the opposite - every picture is the actual aircraft, route or document,
 * and every claim has a person or a report behind it.
 *
 * So the order here is research first. The accident's article is read whole;
 * the outline, the narration and the on-screen quotations are written FROM it
 * and from nothing else; and the pictures are the licensed photographs that
 * article carries, plus maps and cards drawn from its facts.
 *
 * Chapters are rendered one by one and joined, so a failure costs one chapter:
 * everything finished is on disk and a resume skips it.
 *
 * It goes to YouTube, never to TikTok. A long clip is marked in the settings
 * table (`kind:<clipId>` = "long") and every path to the phone checks it.
 */

/** Past eight minutes a video can carry mid-roll ads; under it, it cannot. */
const MIN_TOTAL_SEC = 8 * 60 + 10;
/** An article shorter than this has no story in it - a stub, or the wrong page. */
const MIN_ARTICLE_CHARS = 5000;
const MAX_PICTURES = 44;

/**
 * YouTube plays everything back at about -14 LUFS and turns louder uploads
 * down, but never turns a quiet one up: the first test came out at a mean of
 * -24 dB, which next to any other video sounds like a fault.
 */
const LOUDNESS = "loudnorm=I=-15:TP=-1.5:LRA=11";

const kindKey = (clipId: string) => `kind:${clipId}`;

export function isLongForm(clipId: string): boolean {
  return db.select().from(settings).where(eq(settings.key, kindKey(clipId))).get()?.value === "long";
}

export function longDir(clipId: string): string {
  return path.join(mediaDir, "long", clipId);
}

async function ask<T>(args: { system: string; tool: Anthropic.Tool; prompt: string; maxTokens?: number }): Promise<T> {
  const response = await subscriptionMessagesCreate({
    model: MODELS.strategy,
    max_tokens: args.maxTokens ?? 6000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    system: args.system,
    tools: [args.tool],
    tool_choice: { type: "tool", name: args.tool.name },
    messages: [{ role: "user", content: args.prompt }],
  } as never);
  const block = response.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error(`The agent returned nothing for ${args.tool.name}.`);
  return block.input as T;
}

/* ------------------------------------------------------------------ */
/* Choosing the accident                                               */
/* ------------------------------------------------------------------ */

const PICK_TOOL: Anthropic.Tool = {
  name: "pick_accident",
  description: "Name aviation accidents or incidents worth a long documentary.",
  input_schema: {
    type: "object",
    properties: {
      candidates: {
        type: "array",
        description: "Five, strongest first.",
        items: {
          type: "object",
          properties: {
            article: {
              type: "string",
              description: "The exact title of its English Wikipedia article, e.g. 'British Airways Flight 5390'.",
            },
            why: { type: "string", description: "One line: what makes it a story." },
          },
          required: ["article", "why"],
          additionalProperties: false,
        },
      },
    },
    required: ["candidates"],
    additionalProperties: false,
  },
};

async function pickAccident(accountId: string): Promise<string[]> {
  const made = db
    .select({ hook: clips.hookText, source: clips.sourceUrl })
    .from(clips)
    .where(and(eq(clips.accountId, accountId), ne(clips.sourceUrl, "")))
    .orderBy(desc(clips.createdAt))
    .limit(40)
    .all()
    .map((c) => c.hook || c.source)
    .filter(Boolean);
  const picked = await ask<{ candidates: Array<{ article: string }> }>({
    system:
      "You choose subjects for a YouTube channel of aviation accident investigations. A good subject " +
      "has a thoroughly documented official investigation, named people who made decisions under " +
      "pressure, a sequence that can be followed minute by minute, and a finding that changed " +
      "something. Prefer accidents with survivors or a recovered cockpit recording, where what was " +
      "said is known. Avoid the handful every channel has already made (Tenerife, MH370, Concorde, " +
      "Air France 447) unless nothing else fits.",
    tool: PICK_TOOL,
    prompt: [
      made.length ? `ALREADY MADE HERE (do not repeat):\n${made.map((m) => `- ${m}`).join("\n")}` : "",
      "",
      "Name five.",
    ].join("\n"),
    maxTokens: 2000,
  });
  return (picked.candidates ?? []).map((c) => c.article).filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* The outline                                                         */
/* ------------------------------------------------------------------ */

const OUTLINE_TOOL: Anthropic.Tool = {
  name: "plan_long_video",
  description: "Plan one long-form YouTube documentary from a source article.",
  input_schema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description:
          "The YouTube title. Max 70 characters. The specific event and the reason to click - never a topic label, never a claim the video does not deliver.",
      },
      openLoop: {
        type: "string",
        description:
          "The one question the whole video exists to answer, in the viewer's words. Chapter one plants it; the last chapter answers it.",
      },
      description: {
        type: "string",
        description: "Two or three plain sentences for the YouTube description. No hashtags.",
      },
      tags: { type: "array", items: { type: "string" }, description: "6-10 search tags, no # prefix." },
      thumbnailText: { type: "string", description: "At most four words to set on the thumbnail." },
      musicMood: { type: "string", description: "One or two words for the bed, e.g. 'tense', 'elegiac'." },
      relatedArticles: {
        type: "array",
        items: { type: "string" },
        description:
          "Up to four exact English Wikipedia article titles whose photographs would show this story: the aircraft type, the airline, the airports. Used only to find pictures.",
      },
      pictureSearches: {
        type: "array",
        items: { type: "string" },
        description:
          "Five or six short search phrases for Wikimedia Commons photographs that would SHOW this story in its own era: the airline with the aircraft type ('United Airlines DC-8'), the type's cockpit ('Douglas DC-8 cockpit'), its cabin, its landing gear or engines if they matter to the story, the airport in that decade. Two to four words each; no dates, no flight numbers.",
      },
      places: {
        type: "array",
        description:
          "Every place a map would need: departure and destination airports, the accident site, a diversion airport. Coordinates in decimal degrees.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Short label for the map, e.g. 'Honolulu'." },
            lat: { type: "number" },
            lon: { type: "number" },
          },
          required: ["name", "lat", "lon"],
          additionalProperties: false,
        },
      },
      chapters: {
        type: "array",
        description: "7-10 chapters, in order. Their lengths differ: a chapter is as long as its material.",
        items: {
          type: "object",
          properties: {
            heading: {
              type: "string",
              description: "Max 40 characters. Shown as a card and as a YouTube chapter title.",
            },
            brief: {
              type: "string",
              description:
                "What this chapter tells, as facts from the article in the order they are told - names, times, figures, what was said. The narration is written from this and the article.",
            },
            words: {
              type: "number",
              description: "How long the narration should be, 150-380 words. Across all chapters the total must be 2,000-2,500.",
            },
          },
          required: ["heading", "brief", "words"],
          additionalProperties: false,
        },
      },
      factsToCheck: {
        type: "array",
        items: { type: "string" },
        description:
          "Claims the owner should verify against the official report before publishing: anything the article states without detail, hedges, or marks as disputed.",
      },
    },
    required: [
      "title",
      "openLoop",
      "description",
      "tags",
      "thumbnailText",
      "musicMood",
      "relatedArticles",
      "pictureSearches",
      "places",
      "chapters",
      "factsToCheck",
    ],
    additionalProperties: false,
  },
};

export type Outline = {
  title: string;
  openLoop: string;
  description: string;
  tags: string[];
  thumbnailText: string;
  musicMood: string;
  relatedArticles: string[];
  pictureSearches: string[];
  places: StoryPlace[];
  chapters: Array<{ heading: string; brief: string; words: number }>;
  factsToCheck: string[];
};

const SOURCE_RULE =
  "Everything you state must be in the SOURCE ARTICLE given to you. Do not add facts from memory, " +
  "even ones you are sure of: a name, a time, a figure or a cause that is not in the article does " +
  "not go in. Words inside quotation marks must appear in the article exactly; if the article does " +
  "not quote someone, you do not quote them.";

async function planOutline(article: Article, angle: string | null): Promise<Outline> {
  const raw = await ask<Outline>({
    system:
      "You plan long-form YouTube documentaries about aviation accidents: twelve to sixteen minutes, " +
      "narrated, shown through photographs, maps and on-screen quotations. One video is one event.\n" +
      "Retention decides everything. Chapter one is a cold open: it drops the viewer into the moment " +
      "things go wrong, with a named person, a place and a time, and plants the question without " +
      "answering it. Then the story is told in order - who was aboard, what was normal, the first " +
      "sign, the decisions, the outcome - and the investigation's answer comes in the last chapters " +
      "and nowhere before them. Every chapter ends by making the next one necessary.\n" +
      "People carry it. Name the crew and the people who acted, use what they said, and follow them.\n" +
      SOURCE_RULE,
    tool: OUTLINE_TOOL,
    maxTokens: 8000,
    prompt: [
      angle ? `THE OWNER ASKED FOR: ${angle}\n` : "",
      `SOURCE ARTICLE: ${article.title}`,
      article.text.slice(0, 60_000),
      "",
      "Plan the video.",
    ].join("\n"),
  });

  const chapters = (raw.chapters ?? [])
    .filter((c) => c?.heading && c?.brief)
    .map((c) => ({
      heading: String(c.heading).slice(0, 60),
      brief: String(c.brief),
      words: Math.max(140, Math.min(400, Math.round(Number(c.words) || 250))),
    }));
  if (chapters.length < 5) throw new Error(`The outline has only ${chapters.length} usable chapter(s).`);
  return {
    title: String(raw.title ?? "").slice(0, 100),
    openLoop: String(raw.openLoop ?? ""),
    description: String(raw.description ?? ""),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String).slice(0, 12) : [],
    thumbnailText: String(raw.thumbnailText ?? ""),
    musicMood: String(raw.musicMood ?? ""),
    relatedArticles: Array.isArray(raw.relatedArticles) ? raw.relatedArticles.map(String).slice(0, 4) : [],
    pictureSearches: Array.isArray(raw.pictureSearches) ? raw.pictureSearches.map(String).slice(0, 6) : [],
    places: (Array.isArray(raw.places) ? raw.places : [])
      .filter((p) => p?.name && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon)))
      .map((p) => ({ name: String(p.name), lat: Number(p.lat), lon: Number(p.lon) })),
    chapters,
    factsToCheck: Array.isArray(raw.factsToCheck) ? raw.factsToCheck.map(String) : [],
  };
}

/* ------------------------------------------------------------------ */
/* One chapter's narration                                             */
/* ------------------------------------------------------------------ */

const CHAPTER_TOOL: Anthropic.Tool = {
  name: "write_chapter",
  description: "Write the spoken narration for one chapter of a long documentary.",
  input_schema: {
    type: "object",
    properties: {
      lines: {
        type: "array",
        description: "The narration, one spoken sentence per entry, in order.",
        items: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description:
                "One spoken sentence, averaging 12 words and never over 22. Write numbers as a narrator would say them, and expand abbreviations the voice would otherwise spell out.",
            },
            intent: {
              type: "string",
              enum: ["open", "escalate", "turn", "payoff"],
              description:
                "How the line is paced. open: the first line of a chapter. escalate: adds a fact or raises the stakes - most lines. turn: the story changes direction; a beat of silence comes before it. payoff: the line the chapter was building to; the longest pause comes before it. At most one turn and one payoff per chapter.",
            },
          },
          required: ["text", "intent"],
          additionalProperties: false,
        },
      },
    },
    required: ["lines"],
    additionalProperties: false,
  },
};

async function writeChapter(args: {
  article: Article;
  outline: Outline;
  index: number;
  previousLines: string[];
}): Promise<ScriptLine[]> {
  const { article, outline, index, previousLines } = args;
  const chapter = outline.chapters[index];
  const first = index === 0;
  const last = index === outline.chapters.length - 1;

  const raw = await ask<{ lines?: ScriptLine[] }>({
    system:
      "You write spoken narration for a long-form documentary about an aviation accident, one " +
      "chapter at a time. It is read aloud by a synthetic voice, so write for the ear: declarative " +
      "sentences, concrete nouns, no stacked subordinate clauses, no rhetorical questions, no " +
      "'in this video'. Tell it through people: who was in which seat, what they saw, what they " +
      "said, what they decided. Give times and figures when the article has them - precision is " +
      "what makes it feel true. Every line adds a fact or moves the story.\n" +
      SOURCE_RULE +
      " When you quote, say who is speaking in the same line or the one before.",
    tool: CHAPTER_TOOL,
    prompt: [
      `THE VIDEO: ${outline.title}`,
      `The question it answers at the very end: ${outline.openLoop}`,
      "",
      "ALL CHAPTERS",
      ...outline.chapters.map((c, i) => `${i + 1}. ${c.heading}${i === index ? "   <- write this one" : ""}`),
      "",
      `CHAPTER ${index + 1}: ${chapter.heading}`,
      chapter.brief,
      "",
      previousLines.length
        ? `THE PREVIOUS CHAPTER ENDED WITH\n${previousLines.map((l) => `  ${l}`).join("\n")}\nPick up from there without repeating it.`
        : "",
      "",
      "Requirements:",
      `- About ${chapter.words} words in total (within 25 either way).`,
      first
        ? "- This is the COLD OPEN. Start with a named person, a place and a time, inside the moment things go wrong. Plant the question above within the first four lines and do not answer it. Do not greet the viewer or introduce the channel."
        : "- Do not recap earlier chapters. Start with a new fact.",
      last
        ? "- This is the LAST chapter. Answer the question the video planted, as the investigation found it, then end on what changed because of it. No summary, no sign-off, no call to subscribe."
        : "- Do NOT give the investigation's answer here unless this chapter's brief contains it. End on a line that makes the next chapter necessary.",
      "",
      `SOURCE ARTICLE: ${article.title}`,
      article.text.slice(0, 60_000),
    ]
      .filter(Boolean)
      .join("\n"),
  });

  const intents = new Set(["open", "escalate", "turn", "payoff"]);
  const lines = (raw.lines ?? [])
    .filter((l) => l && typeof l.text === "string" && l.text.trim().length > 0)
    .map((l) => ({ text: l.text.trim(), intent: intents.has(l.intent) ? l.intent : "escalate" }) as ScriptLine);
  if (lines.length < 6) throw new Error(`Chapter ${index + 1} came back with ${lines.length} line(s).`);
  return lines.slice(0, 40);
}

/* ------------------------------------------------------------------ */
/* What is on screen                                                   */
/* ------------------------------------------------------------------ */

const SCENES_TOOL: Anthropic.Tool = {
  name: "plan_scenes",
  description: "Decide what is on screen under each line of narration.",
  input_schema: {
    type: "object",
    properties: {
      scenes: {
        type: "array",
        description: "In order. Together they cover every line exactly once.",
        items: {
          type: "object",
          properties: {
            fromLine: { type: "number", description: "First narration line this scene covers." },
            toLine: { type: "number", description: "Last line it covers (same as fromLine for one line)." },
            kind: {
              type: "string",
              enum: ["photo", "map", "quote", "number", "fact"],
              description:
                "photo: one of the listed pictures, full frame. map: a route or a location. quote: words someone said, shown as text - ONLY for words the narration quotes in these lines. number: one figure the narration says in these lines, very large. fact: a short statement on a card - a time, a finding, a name and role.",
            },
            picture: {
              type: "number",
              description:
                "photo: which picture, by its number in the list. quote / number / fact: optionally a picture to sit dimmed and blurred behind the card.",
            },
            caption: {
              type: "string",
              description:
                "photo: what the picture actually is, from its description, in under 90 characters - e.g. 'The aircraft, N73711, two months before the accident'. If the picture is the same TYPE of aircraft but not the one involved, say so. map: a short label such as the date and flight. Never claim a picture shows more than its description says.",
            },
            text: {
              type: "string",
              description:
                "quote: the quoted words exactly as the narration has them. number: the figure as digits, e.g. '24,000 ft' or '89,680'. fact: the statement, under 110 characters.",
            },
            sub: {
              type: "string",
              description:
                "quote: who said it, with their role. number: what the figure counts. fact: a small heading above it, such as a clock time or 'Finding'.",
            },
            source: { type: "string", description: "quote only: where the words are recorded, e.g. 'Cockpit voice recorder'." },
            from: { type: "string", description: "map: the name of the place the flight left, from the PLACES list." },
            to: { type: "string", description: "map: the name of the place it was going, from the PLACES list." },
            point: { type: "string", description: "map: one place to mark, from the PLACES list - used alone, or with a route." },
            progress: {
              type: "number",
              description: "map with a route: how far along it the aircraft was at this moment, 0-1. Leave out to draw the whole route.",
            },
          },
          required: ["fromLine", "toLine", "kind"],
          additionalProperties: false,
        },
      },
    },
    required: ["scenes"],
    additionalProperties: false,
  },
};

type RawScene = {
  fromLine: number;
  toLine: number;
  kind: StoryScene["kind"];
  picture?: number;
  caption?: string;
  text?: string;
  sub?: string;
  source?: string;
  from?: string;
  to?: string;
  point?: string;
  progress?: number;
};

const creditOf = (p: Picture) => `${p.credit.slice(0, 60)} · ${p.license}`;

/**
 * Turns the narration into a list of timed scenes.
 *
 * Text only: the model is told what each picture is by the description its
 * photographer gave it, and may not caption it as more than that.
 */
async function planScenes(args: {
  outline: Outline;
  index: number;
  lines: VoiceLine[];
  durationMs: number;
  pictures: Picture[];
  /** How often each picture has been the main image so far, across the video. */
  shown: number[];
}): Promise<StoryScene[]> {
  const { outline, index, lines, durationMs, pictures, shown } = args;
  const chapter = outline.chapters[index];

  const raw = await ask<{ scenes?: RawScene[] }>({
    system:
      "You are the picture editor of a documentary about an aviation accident. For each line of " +
      "narration you decide what is on screen, choosing from real photographs, maps and text cards. " +
      "The rule that matters: the screen shows the thing being said. When the narration names the " +
      "aircraft, show the aircraft. When it says where, show the map. When it quotes someone, put " +
      "their words on screen with their name. When it gives a figure, show the figure.\n" +
      "Pace: a new scene every one or two lines, never more than three lines on one scene. Do not " +
      "use the same kind twice running when another fits.\n" +
      "Photographs come first: they are what makes this a film and not a slideshow. At least four " +
      "scenes in ten are photographs whenever fitting pictures are listed - of the aircraft, the " +
      "flight deck, the cabin, the place - including pictures already shown in EARLIER chapters. " +
      "Within one chapter do not show the same photograph twice. Number cards are for the two or " +
      "three figures that matter most in a chapter, never more than three; fold other figures into " +
      "a fact card or leave them to the voice. Cards read better over a dimmed picture than over " +
      "nothing - give them one when a fitting picture exists.\n" +
      "Honesty: a caption says only what the picture's description supports. A stock photograph of " +
      "the same aircraft type is captioned as the type, not as the accident aircraft.",
    tool: SCENES_TOOL,
    maxTokens: 6000,
    prompt: [
      `VIDEO: ${outline.title}`,
      `CHAPTER ${index + 1}: ${chapter.heading}`,
      "",
      "NARRATION",
      ...lines.map((l, i) => `[line ${i}] ${((l.endMs - l.startMs) / 1000).toFixed(1)}s - ${l.text}`),
      "",
      "PICTURES",
      ...(pictures.length
        ? pictures.map(
            (p, i) =>
              `[${i}] ${p.description} (${p.width}x${p.height}, from the article "${p.from}"${shown[i] ? `, already shown ${shown[i]}x` : ""})`,
          )
        : ["(none - use maps and cards only)"]),
      "",
      "PLACES (for maps)",
      ...(outline.places.length ? outline.places.map((p) => `- ${p.name}`) : ["(none)"]),
      "",
      `Cover lines 0 to ${lines.length - 1} in order.`,
    ].join("\n"),
  });

  const place = (name?: string) =>
    name ? outline.places.find((p) => p.name.toLowerCase() === name.trim().toLowerCase()) : undefined;
  const planned = (raw.scenes ?? [])
    .filter((s) => s && Number.isFinite(Number(s.fromLine)))
    .map((s) => ({ ...s, fromLine: Math.max(0, Math.min(lines.length - 1, Math.round(Number(s.fromLine)))) }))
    .sort((a, b) => a.fromLine - b.fromLine)
    // Two scenes claiming the same first line: the earlier one wins.
    .filter((s, i, all) => i === 0 || s.fromLine > all[i - 1].fromLine);
  if (planned.length === 0) throw new Error(`Chapter ${index + 1}: no scenes were planned`);
  planned[0].fromLine = 0;

  const scenes: StoryScene[] = planned.map((s, i) => {
    const startMs = i === 0 ? 0 : lines[s.fromLine].startMs;
    const endMs = i + 1 < planned.length ? lines[planned[i + 1].fromLine].startMs : durationMs;
    const pic = Number.isInteger(s.picture) ? pictures[s.picture as number] : undefined;
    const spoken = lines[s.fromLine].text;
    const base = { startMs, endMs };

    if (s.kind === "photo") {
      if (pic?.file) {
        shown[s.picture as number] = (shown[s.picture as number] ?? 0) + 1;
        return { ...base, kind: "photo", path: pic.file, caption: (s.caption ?? "").slice(0, 110), credit: creditOf(pic) };
      }
      return { ...base, kind: "fact", text: spoken.slice(0, 140) };
    }
    if (s.kind === "map") {
      const from = place(s.from);
      const to = place(s.to);
      const point = place(s.point);
      if ((from && to) || point) {
        return {
          ...base,
          kind: "map",
          ...(from && to ? { from, to } : {}),
          ...(point ? { point } : {}),
          ...(Number.isFinite(Number(s.progress)) ? { progress: Math.max(0, Math.min(1, Number(s.progress))) } : {}),
          caption: (s.caption ?? "").slice(0, 80),
        };
      }
      return { ...base, kind: "fact", text: spoken.slice(0, 140), path: pic?.file };
    }
    if (s.kind === "quote" && s.text) {
      return { ...base, kind: "quote", text: s.text.slice(0, 320), sub: s.sub ?? "", source: s.source, path: pic?.file };
    }
    if (s.kind === "number" && s.text) {
      return { ...base, kind: "number", text: s.text.slice(0, 14), sub: (s.sub ?? "").slice(0, 70), path: pic?.file };
    }
    return { ...base, kind: "fact", text: (s.text || spoken).slice(0, 140), sub: s.sub?.slice(0, 40), path: pic?.file };
  });

  // Every chapter after the cold open begins on its heading: the first three
  // seconds of its opening scene become a title card.
  if (index > 0 && scenes[0].endMs - scenes[0].startMs > 5200) {
    const backdrop = scenes.find((s) => s.path)?.path;
    scenes.unshift({
      kind: "title",
      startMs: 0,
      endMs: 3200,
      text: chapter.heading,
      sub: `Part ${index + 1}`,
      path: backdrop,
    });
    scenes[1] = { ...scenes[1], startMs: 3200 };
  }
  return scenes;
}

/* ------------------------------------------------------------------ */
/* State on disk                                                       */
/* ------------------------------------------------------------------ */

type ChapterDone = {
  file: string;
  durationMs: number;
  heading: string;
  lines: VoiceLine[];
  scenes: number;
};

type State = {
  topic: string | null;
  article?: Article;
  outline?: Outline;
  pictures?: Picture[];
  /** How often each picture has been the main image so far. */
  shown?: number[];
  chapters: Record<number, ChapterDone>;
};

function readState(clipId: string): State | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(longDir(clipId), "state.json"), "utf8")) as State;
  } catch {
    return null;
  }
}

function writeState(clipId: string, state: State) {
  fs.mkdirSync(longDir(clipId), { recursive: true });
  fs.writeFileSync(path.join(longDir(clipId), "state.json"), JSON.stringify(state, null, 1), "utf8");
}

/* ------------------------------------------------------------------ */
/* Research                                                            */
/* ------------------------------------------------------------------ */

/** Finds and reads the article the video is made from. */
async function research(accountId: string, clipId: string, topic: string | null): Promise<Article> {
  const queries = topic ? [topic] : await pickAccident(accountId);
  for (const query of queries) {
    const title = await findArticle(query);
    if (!title) continue;
    const article = await readArticle(title);
    if (article && article.text.length >= MIN_ARTICLE_CHARS) return article;
    noteProgress(clipId, `"${title}" is too thin to make a film from - trying another`);
  }
  throw new Error(
    topic
      ? `No detailed article was found for "${topic}". Name the flight, e.g. "British Airways Flight 5390".`
      : "None of the accidents considered has a detailed article.",
  );
}

/**
 * The photographs of the accident's own article first, then Commons searches
 * for the airline, the type and the era, then the related articles.
 */
async function gatherPictures(clipId: string, article: Article, outline: Outline): Promise<Picture[]> {
  const related = outline.relatedArticles;
  const found: Picture[] = [];
  const seen = new Set<string>();
  const take = (pictures: Picture[], limit: number) => {
    let n = 0;
    for (const p of pictures) {
      if (n >= limit || found.length >= MAX_PICTURES) break;
      if (seen.has(p.name)) continue;
      seen.add(p.name);
      found.push(p);
      n++;
    }
  };
  take(await articlePictures(article.title).catch(() => []), 16);
  for (const search of outline.pictureSearches) {
    take(await commonsPictures(search, 8).catch(() => []), 6);
  }
  for (const title of related) {
    const resolved = (await findArticle(title).catch(() => null)) ?? title;
    take(await articlePictures(resolved).catch(() => []), 3);
  }
  return downloadPictures(found, path.join(longDir(clipId), "pictures"));
}

/* ------------------------------------------------------------------ */
/* Producing                                                           */
/* ------------------------------------------------------------------ */

async function produceChapter(clipId: string, state: State, index: number): Promise<ChapterDone> {
  const outline = state.outline!;
  const chapter = outline.chapters[index];
  const label = `Chapter ${index + 1}/${outline.chapters.length}`;
  const id = `${clipId}-c${index}`;

  noteProgress(clipId, `${label}: writing "${chapter.heading}"`);
  const script = await writeChapter({
    article: state.article!,
    outline,
    index,
    previousLines: (state.chapters[index - 1]?.lines ?? []).slice(-2).map((l) => l.text),
  });

  // The voice service refuses a request now and then (a 403 on the handshake)
  // and takes the next one; a chapter is too much work to lose to that.
  let narration: Awaited<ReturnType<typeof speak>> | null = null;
  for (let attempt = 1; !narration; attempt++) {
    try {
      narration = await speak(id, script);
    } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise((resolve) => setTimeout(resolve, attempt * 15_000));
    }
  }

  const shown = state.shown ?? [];
  const scenes = await planScenes({
    outline,
    index,
    lines: narration.lines,
    durationMs: narration.durationMs,
    pictures: state.pictures ?? [],
    shown,
  });
  state.shown = shown;

  const kinds = scenes.reduce<Record<string, number>>((n, s) => ({ ...n, [s.kind]: (n[s.kind] ?? 0) + 1 }), {});
  noteProgress(
    clipId,
    `${label}: ${(narration.durationMs / 1000).toFixed(0)}s, ${scenes.length} scenes (${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(", ")}) - rendering`,
  );

  const file = await renderStory(id, {
    scenes,
    voicePath: narration.audioPath,
    durationMs: narration.durationMs,
  });

  return { file, durationMs: narration.durationMs, heading: chapter.heading, lines: narration.lines, scenes: scenes.length };
}

const stamp = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

function srtTime(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(Math.floor(ms % 1000)).padStart(3, "0")}`;
}

/** Joins the chapters, lays the bed under the whole film, and returns the file. */
async function assemble(clipId: string, done: ChapterDone[], musicPath: string | null): Promise<string> {
  ensureDirs();
  const { bin, prefix } = splitCmd(env.ffmpeg);
  const list = path.join(longDir(clipId), "chapters.txt");
  fs.writeFileSync(
    list,
    done.map((c) => `file '${path.resolve(c.file).replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"),
    "utf8",
  );
  const output = path.join(outDir, `${clipId}.mp4`);
  const music =
    musicPath && fs.existsSync(musicPath)
      ? [
          "-stream_loop", "-1", "-i", path.resolve(musicPath),
          "-filter_complex",
          // Low and constant: over fifteen minutes a bed that pumps under every
          // sentence is more tiring than one that simply sits there.
          `[1:a]volume=0.09[bed];[0:a][bed]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,${LOUDNESS}[a]`,
          "-map", "0:v", "-map", "[a]",
        ]
      : ["-filter_complex", `[0:a]${LOUDNESS}[a]`, "-map", "0:v", "-map", "[a]"];
  await run(
    bin,
    [
      ...prefix,
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "concat", "-safe", "0", "-i", list,
      ...music,
      // Chapters come out of the same renderer with the same settings, so the
      // picture is joined as it is; only the sound is rewritten.
      "-c:v", "copy",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-movflags", "+faststart",
      output,
    ],
    { timeoutMs: 30 * 60_000 },
  );
  if (!fs.existsSync(output) || fs.statSync(output).size < 100_000) {
    throw new Error("The chapters were joined but no usable file came out.");
  }
  return output;
}

/** What YouTube needs alongside the file: description with chapters and credits, and subtitles. */
function writeSidecars(clipId: string, state: State, done: ChapterDone[]): { description: string } {
  const outline = state.outline!;
  let at = 0;
  const marks: string[] = [];
  const srt: string[] = [];
  let n = 1;
  for (const c of done) {
    marks.push(`${stamp(at / 1000)} ${c.heading}`);
    for (const l of c.lines) {
      srt.push(`${n++}\n${srtTime(at + l.startMs)} --> ${srtTime(at + l.endMs)}\n${l.text}\n`);
    }
    at += c.durationMs;
  }
  // Creative Commons pictures may be used only with their credit; this is it.
  const used = (state.pictures ?? []).filter((_, i) => (state.shown?.[i] ?? 0) > 0);
  const description = [
    outline.description,
    "",
    "CHAPTERS",
    ...marks,
    "",
    "SOURCE",
    `${state.article!.title} - ${state.article!.url} (text CC BY-SA 4.0), which summarises the official investigation report.`,
    "",
    "PICTURES",
    ...used.map((p) => `- ${p.name.replace(/^File:/, "")} - ${p.credit} (${p.license}), via Wikimedia Commons`),
  ].join("\n");

  const dir = longDir(clipId);
  fs.writeFileSync(path.join(dir, "subtitles.srt"), srt.join("\n"), "utf8");
  fs.writeFileSync(
    path.join(dir, "youtube.txt"),
    [
      `TITLE\n${outline.title}`,
      `\nTHUMBNAIL TEXT\n${outline.thumbnailText}`,
      `\nDESCRIPTION\n${description}`,
      `\nTAGS\n${outline.tags.join(", ")}`,
      `\nCHECK BEFORE PUBLISHING\n${outline.factsToCheck.map((f) => `- ${f}`).join("\n") || "- (nothing listed)"}`,
    ].join("\n"),
    "utf8",
  );
  return { description };
}

/**
 * Makes one long-form video, start to finish, or carries on with one that
 * stopped part way (`clipId`).
 *
 * `topic` names the accident ("British Airways Flight 5390"); without it the
 * agent picks one. Ends at "ready" with the file, the YouTube description and
 * subtitles on disk, and the video in Telegram for review. Nothing here
 * publishes.
 */
export async function makeLongVideo(
  accountId: string,
  opts: { topic?: string | null; clipId?: string } = {},
): Promise<string> {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) throw new Error(`No account ${accountId}`);

  let clipId = opts.clipId;
  let state: State;
  if (clipId) {
    if (!isLongForm(clipId)) throw new Error(`Clip ${clipId} is not a long-form video`);
    state = readState(clipId) ?? { topic: opts.topic ?? null, chapters: {} };
  } else {
    const clip = db
      .insert(clips)
      .values({
        accountId,
        sourceType: "url",
        sourceUrl: opts.topic ?? "",
        status: "deciding",
      })
      .returning()
      .get();
    clipId = clip.id;
    db.insert(settings).values({ key: kindKey(clipId), value: "long" }).run();
    state = { topic: opts.topic ?? null, chapters: {} };
    writeState(clipId, state);
  }
  const id = clipId;
  const set = (fields: Record<string, unknown>) => db.update(clips).set(fields as never).where(eq(clips.id, id)).run();

  try {
    if (!state.article) {
      noteProgress(id, state.topic ? `Researching: ${state.topic}` : "Choosing an accident to tell");
      state.article = await research(accountId, id, state.topic);
      writeState(id, state);
      noteProgress(id, `Reading "${state.article.title}" (${Math.round(state.article.text.length / 1000)}k characters)`);
    }
    set({ status: "choosing", sourceUrl: state.article.url, sourceTitle: state.article.title, error: null });

    if (!state.outline) {
      state.outline = await planOutline(state.article, state.topic);
      writeState(id, state);
    }
    const outline = state.outline;

    if (!state.pictures) {
      noteProgress(id, "Collecting licensed photographs of the aircraft, the people and the places");
      state.pictures = await gatherPictures(id, state.article, outline);
      state.shown = state.pictures.map(() => 0);
      writeState(id, state);
    }

    const minutes = Math.round(outline.chapters.reduce((n, c) => n + c.words, 0) / 150);
    set({
      status: "scripting",
      hookText: outline.title,
      openLoop: outline.openLoop,
      hashtags: JSON.stringify(outline.tags),
      rationale: outline.factsToCheck.length
        ? `Check before publishing:\n${outline.factsToCheck.map((f) => `- ${f}`).join("\n")}`
        : null,
    });
    logEvent({
      accountId,
      type: "long.planned",
      message:
        `Long video planned: "${outline.title}" - ${outline.chapters.length} chapters, about ${minutes} minutes, ` +
        `from "${state.article.title}" with ${state.pictures.length} photograph(s).`,
      telegram: true,
    });

    for (let i = 0; i < outline.chapters.length; i++) {
      const have = state.chapters[i];
      if (have && fs.existsSync(have.file)) continue;

      set({ status: "editing" });
      // One more try on a chapter costs minutes; restarting the film costs an hour.
      let lastError: unknown;
      for (let attempt = 1; attempt <= 2 && !state.chapters[i]?.file; attempt++) {
        try {
          state.chapters[i] = await produceChapter(id, state, i);
          writeState(id, state);
        } catch (err) {
          lastError = err;
          delete state.chapters[i];
          noteProgress(id, `Chapter ${i + 1} failed (try ${attempt}/2): ${err instanceof Error ? err.message.split("\n")[0] : err}`);
        }
      }
      if (!state.chapters[i]) throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    const done = outline.chapters.map((_, i) => state.chapters[i]);
    noteProgress(id, `Joining ${done.length} chapters`);
    const track = pickTrack(outline.musicMood);
    const output = await assemble(id, done, track?.path ?? null);
    const info = await probe(output);
    const { description } = writeSidecars(id, state, done);

    let thumb: string | null = null;
    try {
      thumb = await extractThumbnail(output, id);
    } catch {
      thumb = null;
    }

    set({
      status: "ready",
      outputPath: output,
      thumbnailPath: thumb,
      outputDurationSec: info.durationSec,
      sizeBytes: info.sizeBytes,
      caption: description,
      script: JSON.stringify(done.flatMap((c) => c.lines.map((l) => ({ text: l.text, intent: l.intent })))),
      musicPath: track?.path ?? null,
      error: null,
    });
    for (const c of done) fs.rmSync(c.file, { force: true });

    const short = info.durationSec < MIN_TOTAL_SEC;
    noteProgress(
      id,
      `Done - ${stamp(info.durationSec)}, ${done.length} chapters, ${done.reduce((n, c) => n + c.scenes, 0)} scenes. Title, description and subtitles are in ${longDir(id)}`,
    );
    logEvent({
      accountId,
      level: short ? "warn" : "success",
      type: "long.ready",
      message:
        `Long video ready: "${outline.title}" (${stamp(info.durationSec)})` +
        (short ? " - under 8 minutes, so it cannot carry mid-roll ads" : ""),
      telegram: false,
    });
    await telegramVideo(
      output,
      [
        `🎞 Long video ready for review - @${account.handle}`,
        `${outline.title} (${stamp(info.durationSec)})`,
        `Written from: ${state.article.title}`,
        short ? "⚠️ Under 8 minutes - no mid-roll ads at this length." : "",
        outline.factsToCheck.length
          ? `\nCheck before publishing:\n${outline.factsToCheck.slice(0, 5).map((f) => `- ${f.slice(0, 140)}`).join("\n")}`
          : "",
        "\nThis is a small review copy. Approve keeps it for YouTube; nothing is posted to TikTok.",
      ]
        .filter(Boolean)
        .join("\n"),
      [
        [
          { text: "✅ Approve", callback_data: `approve:${id}` },
          { text: "❌ Reject", callback_data: `reject:${id}` },
        ],
      ],
    );
    return id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    set({ status: "failed", error: message.slice(0, 2000) });
    logEvent({
      accountId,
      level: "error",
      type: "long.failed",
      message: `Long video stopped: ${message.split("\n")[0]}. Finished chapters are kept - resume with: npm run make -- ${account.handle} --long --resume ${id}`,
    });
    throw err;
  }
}
