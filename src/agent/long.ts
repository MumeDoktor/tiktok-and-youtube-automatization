import fs from "node:fs";
import path from "node:path";

import { and, desc, eq, ne } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "@/db";
import { accounts, clips, contentProfiles, settings } from "@/db/schema";
import { subscriptionMessagesCreate } from "@/lib/claude-subscription";
import { downloadAsset, getAsset } from "@/lib/dvids";
import { env, MODELS } from "@/lib/env";
import type { Move, Transition } from "@/lib/look";
import {
  ensureDirs,
  extractThumbnail,
  fetchShots,
  mediaDir,
  outDir,
  probe,
  probeRemoteDuration,
  run,
  splitCmd,
} from "@/lib/media";
import { pickTrack } from "@/lib/music";
import { renderClip } from "@/lib/remotion";
import { telegramVideo } from "@/lib/telegram";
import { speak, type ScriptLine, type VoiceLine } from "@/lib/tts";
import { logEvent, noteProgress } from "./events";
import { findFootage, type Candidate } from "./footage";
import { archiveReach } from "./produce";
import { assignShots, surveyFilm, type FilmMoment, type Survey } from "./shots";

/**
 * Long-form video: an 8-12 minute narrated documentary in a 16:9 frame.
 *
 * A short is one film, one narration, one edit. A long video is the same unit
 * several times over - a chapter - under one outline, so each chapter can
 * stand on footage that actually shows what it is saying. Chapters are
 * rendered one by one and joined, which also means a failure at chapter six
 * costs chapter six: everything finished is on disk and a resume skips it.
 *
 * It goes to YouTube, never to TikTok. A long clip is marked in the settings
 * table (`kind:<clipId>` = "long") and every path to the phone checks it.
 */

/** Past eight minutes a video can carry mid-roll ads; under it, it cannot. */
const MIN_TOTAL_SEC = 8 * 60 + 10;
const CHAPTERS = 8;
/** About 80 seconds a chapter at the narrator's pace. */
const CHAPTER_WORDS = 195;
/** A film with fewer unused moments than this cannot carry another chapter. */
const MIN_MOMENTS = 6;

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

/* ------------------------------------------------------------------ */
/* The outline                                                         */
/* ------------------------------------------------------------------ */

const OUTLINE_TOOL: Anthropic.Tool = {
  name: "plan_long_video",
  description: "Plan one long-form YouTube documentary: its title, its question, and its chapters.",
  input_schema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description:
          "The YouTube title. Max 70 characters. A specific story with a reason to click - never a topic label, never a claim the video does not deliver.",
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
      chapters: {
        type: "array",
        description: `Exactly ${CHAPTERS} chapters, in order. Each is about 80 seconds of narration.`,
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
                "What this chapter tells, as 4-7 sentences of FACTS in the order they are told - names, dates, numbers, what happened. The narration is written from this, so anything not here will not be said.",
            },
            searchTerms: {
              type: "string",
              description:
                "What is ON SCREEN during this chapter, not the narrative: several short searches of 2-3 words each, separated by ';', e.g. 'B-29 bomber takeoff; atomic test Nevada; sailors deck'. The archive matches every word of a search and catalogues films by subject, so an operation's name or a long phrase finds nothing.",
            },
          },
          required: ["heading", "brief", "searchTerms"],
          additionalProperties: false,
        },
      },
      factsToCheck: {
        type: "array",
        items: { type: "string" },
        description:
          "Every specific claim in the briefs that the owner should verify before publishing - figures, dates, names, quotations. Be honest about what you are least sure of.",
      },
    },
    required: [
      "title",
      "openLoop",
      "description",
      "tags",
      "thumbnailText",
      "musicMood",
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
  chapters: Array<{ heading: string; brief: string; searchTerms: string }>;
  factsToCheck: string[];
};

async function planOutline(accountId: string, topic: string | null): Promise<Outline> {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) throw new Error(`No account ${accountId}`);
  const profile = db.select().from(contentProfiles).where(eq(contentProfiles.accountId, accountId)).get();

  const alreadyMade = db
    .select({ hook: clips.hookText })
    .from(clips)
    .where(and(eq(clips.accountId, accountId), ne(clips.sourceUrl, "")))
    .orderBy(desc(clips.createdAt))
    .limit(25)
    .all()
    .map((c) => c.hook)
    .filter(Boolean);

  const response = await subscriptionMessagesCreate({
    model: MODELS.strategy,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    system:
      "You plan long-form YouTube documentaries: nine to eleven minutes, narrated, in a 16:9 frame, " +
      "built entirely from public-domain film. One video tells ONE story - an incident, a decision, " +
      "a thing that went wrong - not a survey of a subject.\n" +
      "Retention decides everything. Chapter one is a cold open: it drops the viewer into the most " +
      "striking moment and plants the question, without answering it. Each later chapter raises the " +
      "stakes or turns the story, and ends by pulling into the next. The answer comes in the last " +
      "chapter and nowhere before it.\n" +
      "The pictures come from here, and a chapter can only be made if this holds film of it:\n" +
      `- ${archiveReach()}\n` +
      "So choose a story whose chapters can each be SHOWN with footage of that kind, and write each " +
      "chapter's searches for what would be on screen.\n" +
      "Facts: state only what is well documented and that you are confident of. No invented " +
      "quotations, no invented figures; where you are unsure of a number or a name, leave it out. " +
      "List what the owner should verify.",
    tools: [OUTLINE_TOOL],
    tool_choice: { type: "tool", name: "plan_long_video" },
    messages: [
      {
        role: "user",
        content: [
          `Channel: @${account.handle} - ${account.niche}`,
          profile?.toneOfVoice ? `Tone: ${profile.toneOfVoice}` : "",
          "",
          topic
            ? `THE OWNER ASKED FOR THIS STORY\n${topic}`
            : "Pick the story yourself: the strongest single incident in this channel's subject that the archive can show.",
          "",
          alreadyMade.length ? `ALREADY MADE HERE (do not repeat):\n${alreadyMade.map((h) => `- ${h}`).join("\n")}` : "",
          "",
          `Plan the video in exactly ${CHAPTERS} chapters.`,
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });

  const block = response.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("The agent returned no outline.");
  const raw = block.input as Outline;
  const chapters = (raw.chapters ?? []).filter((c) => c?.heading && c?.brief && c?.searchTerms);
  if (chapters.length < 5) throw new Error(`The outline has only ${chapters.length} usable chapter(s).`);
  return {
    title: String(raw.title ?? "").slice(0, 100),
    openLoop: String(raw.openLoop ?? ""),
    description: String(raw.description ?? ""),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String).slice(0, 12) : [],
    thumbnailText: String(raw.thumbnailText ?? ""),
    musicMood: String(raw.musicMood ?? ""),
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
                "One spoken sentence, averaging 11 words and never over 18. Write numbers as a narrator would say them, and expand abbreviations the voice would otherwise spell out.",
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
  outline: Outline;
  index: number;
  footage: string;
  previousLines: string[];
}): Promise<ScriptLine[]> {
  const { outline, index, footage, previousLines } = args;
  const chapter = outline.chapters[index];
  const first = index === 0;
  const last = index === outline.chapters.length - 1;

  const response = await subscriptionMessagesCreate({
    model: MODELS.strategy,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    system:
      "You write spoken narration for a long-form documentary, one chapter at a time. It is read " +
      "aloud by a synthetic voice, so write for the ear: declarative sentences, concrete nouns, no " +
      "stacked subordinate clauses, no rhetorical questions, no 'in this video'. " +
      "Every line adds a fact or moves the story; a line that only supplies mood is cut. " +
      "The facts come from the chapter brief. You may add a detail only if it is well documented " +
      "and you are certain of it - never an invented quotation, figure or name. " +
      "You are told what footage will be on screen: let the narration sit naturally over it, but " +
      "never describe the footage itself and never claim it shows the exact event.",
    tools: [CHAPTER_TOOL],
    tool_choice: { type: "tool", name: "write_chapter" },
    messages: [
      {
        role: "user",
        content: [
          `THE VIDEO: ${outline.title}`,
          `The question it answers at the very end: ${outline.openLoop}`,
          "",
          "ALL CHAPTERS",
          ...outline.chapters.map((c, i) => `${i + 1}. ${c.heading}${i === index ? "   <- write this one" : ""}`),
          "",
          `CHAPTER ${index + 1}: ${chapter.heading}`,
          chapter.brief,
          "",
          "FOOTAGE ON SCREEN DURING THIS CHAPTER",
          footage,
          "",
          previousLines.length
            ? `THE PREVIOUS CHAPTER ENDED WITH\n${previousLines.map((l) => `  ${l}`).join("\n")}\nPick up from there without repeating it.`
            : "",
          "",
          "Requirements:",
          `- About ${CHAPTER_WORDS} words in total (${CHAPTER_WORDS - 20}-${CHAPTER_WORDS + 20}), in 14-20 lines. That is roughly 80 seconds spoken.`,
          first
            ? "- This is the COLD OPEN. Start inside the most striking moment of the whole story, plant the question above within the first three lines, and do not answer it. Do not greet the viewer or introduce the channel."
            : "- Do not recap earlier chapters. Start with a new fact.",
          last
            ? "- This is the LAST chapter. Answer the question the video planted, as information, then end on the consequence - what changed because of it. No summary, no sign-off, no call to subscribe."
            : "- Do NOT answer the video's question here. End on a line that makes the next chapter necessary.",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });

  const block = response.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("The agent returned no chapter.");
  const intents = new Set(["open", "escalate", "turn", "payoff"]);
  const lines = ((block.input as { lines?: ScriptLine[] }).lines ?? [])
    .filter((l) => l && typeof l.text === "string" && l.text.trim().length > 0)
    .map((l) => ({ text: l.text.trim(), intent: intents.has(l.intent) ? l.intent : "escalate" }) as ScriptLine);
  if (lines.length < 6) throw new Error(`Chapter ${index + 1} came back with ${lines.length} line(s).`);
  return lines.slice(0, 24);
}

/* ------------------------------------------------------------------ */
/* Footage, shared across chapters                                     */
/* ------------------------------------------------------------------ */

type Film = {
  candidate: Candidate;
  survey: Survey;
  /** Set for a DVIDS asset, which is fetched whole and cut on disk. */
  localFile: string | null;
  /** Source timestamps already shown, so a later chapter takes fresh shots. */
  used: Set<number>;
};

const unused = (film: Film): FilmMoment[] => film.survey.moments.filter((m) => !film.used.has(m.atSec));

/**
 * Finds a film that can show one chapter.
 *
 * A film surveyed for an earlier chapter is reused while it still has moments
 * nobody has seen: archive films run twenty minutes and one chapter takes
 * about fifteen shots of it. When the search finds nothing new, the film with
 * the most left is used rather than losing the chapter.
 */
async function filmFor(
  accountId: string,
  clipId: string,
  films: Map<string, Film>,
  searchTerms: string,
  label: string,
  /** Shots earlier chapters took from each film, from a run that was resumed. */
  shown: Map<string, number[]>,
): Promise<Film> {
  const exclude = new Set<string>();
  for (const [key, film] of films) if (unused(film).length < MIN_MOMENTS) exclude.add(key);

  for (let attempt = 1; attempt <= 3; attempt++) {
    const pick = await findFootage(accountId, searchTerms, exclude).catch(() => null);
    if (!pick?.found || !pick.candidate) break;
    const candidate = pick.candidate;

    const known = films.get(candidate.key);
    if (known) return known;

    let localFile: string | null = null;
    let length = candidate.durationSec ?? 0;
    try {
      if (candidate.source === "dvids" && candidate.dvids) {
        const asset = candidate.dvids.downloadUrl
          ? candidate.dvids
          : ((await getAsset(candidate.dvids.id)) ?? candidate.dvids);
        localFile = await downloadAsset(asset, `${clipId}-${candidate.dvids.id}`);
        length = (await probe(localFile)).durationSec;
      } else {
        length = (await probeRemoteDuration(candidate.pageUrl)) ?? 0;
      }
    } catch {
      length = 0;
    }
    if (length <= 0) {
      exclude.add(candidate.key);
      continue;
    }

    noteProgress(clipId, `${label}: looking at "${candidate.title}" (${Math.round(length / 60)} min)`);
    const survey = await surveyFilm(accountId, candidate.pageUrl, length, searchTerms);
    if (!survey.found || survey.moments.length < MIN_MOMENTS) {
      noteProgress(clipId, `${label}: rejected "${candidate.title}" - ${survey.reason}`);
      exclude.add(candidate.key);
      if (localFile) fs.rmSync(localFile, { force: true });
      continue;
    }

    const film: Film = { candidate, survey, localFile, used: new Set(shown.get(candidate.key) ?? []) };
    films.set(candidate.key, film);
    return film;
  }

  // Nothing new: fall back to whichever film already surveyed has most left.
  const fallback = [...films.values()].sort((a, b) => unused(b).length - unused(a).length)[0];
  if (!fallback) throw new Error(`No usable footage for "${searchTerms.slice(0, 80)}"`);
  // Every moment already shown: better to see a shot twice across ten minutes
  // than to lose the chapter.
  if (unused(fallback).length < MIN_MOMENTS) fallback.used.clear();
  noteProgress(clipId, `${label}: nothing new in the archive - continuing with "${fallback.candidate.title}"`);
  return fallback;
}

/* ------------------------------------------------------------------ */
/* State on disk                                                       */
/* ------------------------------------------------------------------ */

type ChapterDone = {
  file: string;
  durationMs: number;
  heading: string;
  lines: VoiceLine[];
  film: string;
  /** Which film, and which of its moments, so a resumed run does not show them again. */
  filmKey?: string;
  shotsAt?: number[];
};

type State = {
  topic: string | null;
  outline?: Outline;
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
/* Producing                                                           */
/* ------------------------------------------------------------------ */

async function produceChapter(
  accountId: string,
  clipId: string,
  outline: Outline,
  index: number,
  films: Map<string, Film>,
  previousLines: string[],
  shown: Map<string, number[]>,
): Promise<ChapterDone> {
  const chapter = outline.chapters[index];
  const label = `Chapter ${index + 1}/${outline.chapters.length}`;
  const id = `${clipId}-c${index}`;

  const film = await filmFor(accountId, clipId, films, chapter.searchTerms, label, shown);
  const moments = unused(film);

  noteProgress(clipId, `${label}: writing "${chapter.heading}" over "${film.candidate.title}"`);
  const script = await writeChapter({
    outline,
    index,
    footage: `${film.candidate.title} (${film.candidate.when})\n${film.survey.summary}`,
    previousLines,
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
  const planned = await assignShots(script, narration.lines, moments);
  if (planned.length === 0) throw new Error(`${label}: no shots could be assigned`);
  for (const p of planned) film.used.add(p.atSec);

  const fetched = await fetchShots(film.candidate.pageUrl, id, planned, {
    localFile: film.localFile ?? undefined,
  });

  // A shot that failed to download leaves a hole; the nearest good one is held
  // over it. The cut is lost, the narration stays in sync.
  const shots: Array<{
    path: string;
    startMs: number;
    endMs: number;
    move: Move;
    transition: Transition;
    transitionMs: number;
  }> = [];
  const firstGood = fetched.find(Boolean)?.path ?? null;
  let lastGood: string | null = firstGood;
  for (let i = 0; i < planned.length; i++) {
    const file: string | null = fetched[i]?.path ?? lastGood;
    if (!file) continue;
    lastGood = file;
    shots.push({
      path: file,
      startMs: planned[i].startMs,
      endMs: planned[i].endMs,
      move: planned[i].move,
      // Whips and flashes are a short-form habit; over ten minutes they tire.
      transition: planned[i].transition === "cut" || planned[i].transition === "dipToBlack" ? planned[i].transition : "dissolve",
      transitionMs: planned[i].transition === "cut" ? 0 : 420,
    });
  }
  if (shots.length === 0) throw new Error(`${label}: none of the shots could be downloaded`);
  shots[0] = { ...shots[0], startMs: 0, transition: "cut", transitionMs: 0 };

  const distinct = new Set(shots.map((s) => s.path)).size;
  noteProgress(
    clipId,
    `${label}: ${(narration.durationMs / 1000).toFixed(0)}s of narration over ${distinct} shot(s) - rendering`,
  );

  const file = await renderClip(id, {
    shots,
    words: narration.words,
    lines: narration.lines,
    hookText: "",
    voicePath: narration.audioPath,
    durationMs: narration.durationMs,
    hits: [],
    wide: true,
    look: {
      captions: "none",
      hookExit: 2,
      accent: "#E0A526",
      grade: "archive",
      chrome: ["grain"],
      stamps: [],
      motion: {
        lightLeak: false,
        vignette: true,
        speedRamp: false,
        // The cold open has no card: nothing should sit between the viewer and
        // the first picture.
        ...(index > 0 ? { lowerThird: { text: chapter.heading, atSec: 0.8, holdSec: 3.5 } } : {}),
      },
    } as never,
  });

  for (const f of new Set(fetched.filter(Boolean).map((f) => f!.path))) fs.rmSync(f, { force: true });

  return {
    file,
    durationMs: narration.durationMs,
    heading: chapter.heading,
    lines: narration.lines,
    film: `${film.candidate.title} (${film.candidate.when}) - ${film.candidate.credit}`,
    filmKey: film.candidate.key,
    shotsAt: planned.map((p) => p.atSec),
  };
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
          // Low and constant: over ten minutes a bed that pumps under every
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

/** What YouTube needs alongside the file: description with chapters, and subtitles. */
function writeSidecars(clipId: string, outline: Outline, done: ChapterDone[]): { description: string } {
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
  const films = [...new Set(done.map((c) => c.film))];
  const description = [
    outline.description,
    "",
    "CHAPTERS",
    ...marks,
    "",
    "FOOTAGE (public domain)",
    ...films.map((f) => `- ${f}`),
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
 * Ends at "ready" with the file, the YouTube description and subtitles on
 * disk, and the video in Telegram for review. Nothing here publishes.
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
        sourceType: "dvids",
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
    if (!state.outline) {
      noteProgress(id, state.topic ? `Planning a long video: ${state.topic}` : "Planning a long video - choosing the story");
      state.outline = await planOutline(accountId, state.topic);
      writeState(id, state);
    }
    const outline = state.outline;
    set({
      status: "scripting",
      hookText: outline.title,
      openLoop: outline.openLoop,
      sourceUrl: state.topic || outline.title,
      hashtags: JSON.stringify(outline.tags),
      rationale: outline.factsToCheck.length
        ? `Check before publishing:\n${outline.factsToCheck.map((f) => `- ${f}`).join("\n")}`
        : null,
      error: null,
    });
    logEvent({
      accountId,
      type: "long.planned",
      message: `Long video planned: "${outline.title}" - ${outline.chapters.length} chapters, about ${Math.round((outline.chapters.length * 80) / 60)} minutes. This takes a couple of hours.`,
      telegram: true,
    });

    const films = new Map<string, Film>();
    const shown = new Map<string, number[]>();
    for (const c of Object.values(state.chapters)) {
      if (c.filmKey) shown.set(c.filmKey, [...(shown.get(c.filmKey) ?? []), ...(c.shotsAt ?? [])]);
    }
    for (let i = 0; i < outline.chapters.length; i++) {
      const have = state.chapters[i];
      if (have && fs.existsSync(have.file)) continue;

      set({ status: "editing" });
      const previous = (state.chapters[i - 1]?.lines ?? []).slice(-2).map((l) => l.text);
      // One more try on a chapter costs minutes; restarting the film costs hours.
      let lastError: unknown;
      for (let attempt = 1; attempt <= 2 && !state.chapters[i]?.file; attempt++) {
        try {
          const done = await produceChapter(accountId, id, outline, i, films, previous, shown);
          state.chapters[i] = done;
          writeState(id, state);
        } catch (err) {
          lastError = err;
          delete state.chapters[i];
          noteProgress(id, `Chapter ${i + 1} failed (try ${attempt}/2): ${err instanceof Error ? err.message.split("\n")[0] : err}`);
        }
      }
      if (!state.chapters[i]) throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
    for (const film of films.values()) if (film.localFile) fs.rmSync(film.localFile, { force: true });

    const done = outline.chapters.map((_, i) => state.chapters[i]);
    noteProgress(id, `Joining ${done.length} chapters`);
    const track = pickTrack(outline.musicMood);
    const output = await assemble(id, done, track?.path ?? null);
    const info = await probe(output);
    const { description } = writeSidecars(id, outline, done);

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
      `Done - ${stamp(info.durationSec)}, ${done.length} chapters. Title, description and subtitles are in ${longDir(id)}`,
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
        short ? "⚠️ Under 8 minutes - no mid-roll ads at this length." : "",
        outline.factsToCheck.length
          ? `\nCheck before publishing:\n${outline.factsToCheck.slice(0, 6).map((f) => `- ${f}`).join("\n")}`
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
