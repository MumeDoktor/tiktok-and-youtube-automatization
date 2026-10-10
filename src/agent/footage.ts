import fs from "node:fs";

import { eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "@/db";
import { accounts, clips, contentProfiles } from "@/db/schema";
import { subscriptionMessagesCreate } from "@/lib/claude-subscription";
import { searchArchive, type ArchiveItem } from "@/lib/archiveorg";
import { downloadAsset, getAsset, searchVideos, type DvidsAsset } from "@/lib/dvids";
import { env, MODELS } from "@/lib/env";
import { extractThumbnail, fetchShots, probe, probeRemoteDuration } from "@/lib/media";
import { resolveHits, type Move, type TimedHit, type Transition } from "@/lib/look";
import { pickTrack } from "@/lib/music";
import { buildSoundtrack, planSoundDesign } from "@/lib/mix";
import { renderClip } from "@/lib/remotion";
import { aeTargetSec, sourceWindowSec, useAeEditor } from "@/lib/ae-editor";
import { speak, trimToBudget } from "@/lib/tts";
import type { AeEditPayload } from "./ae-edit";
import { enqueue, logEvent, noteProgress } from "./events";
import { writeScript } from "./script";
import { assignShots, surveyFilm } from "./shots";

function setStatus(clipId: string, status: string, fields: Record<string, unknown> = {}) {
  db.update(clips)
    .set({ status: status as never, ...fields })
    .where(eq(clips.id, clipId))
    .run();
}

/* ------------------------------------------------------------------ */
/* One list, two archives                                              */
/* ------------------------------------------------------------------ */

export type Candidate = {
  key: string;
  source: "dvids" | "archive";
  title: string;
  description: string;
  durationSec: number | null;
  when: string;
  credit: string;
  pageUrl: string;
  dvids?: DvidsAsset;
  archive?: ArchiveItem;
};

/**
 * Searches every public-domain source available and merges the results.
 *
 * DVIDS carries modern DoD material but needs an API key. The Internet Archive
 * needs none, but its public-domain collections are mid-century film, so the
 * two cover different eras rather than duplicating each other.
 */
export async function searchAllSources(
  accountId: string,
  query: string,
): Promise<Candidate[]> {
  const out: Candidate[] = [];

  if (env.dvidsApiKey) {
    try {
      for (const a of await searchVideos(query, { maxResults: 12 })) {
        out.push({
          key: `dvids:${a.id}`,
          source: "dvids",
          title: a.title,
          description: a.description,
          durationSec: a.durationSec,
          when: a.publishedAt?.toISOString().slice(0, 10) ?? "unknown",
          credit: a.unit ?? a.branch ?? "U.S. DoD",
          pageUrl: a.pageUrl,
          dvids: a,
        });
      }
    } catch (err) {
      logEvent({
        accountId,
        level: "warn",
        type: "dvids.search_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  try {
    for (const item of await searchArchive(query, { maxResults: 12 })) {
      out.push({
        key: `archive:${item.id}`,
        source: "archive",
        title: item.title,
        description: item.description,
        durationSec: null,
        when: item.year ? String(item.year) : "unknown",
        credit: "Prelinger Archives - public domain",
        pageUrl: item.pageUrl,
        archive: item,
      });
    }
  } catch (err) {
    logEvent({
      accountId,
      level: "warn",
      type: "archive.search_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Choosing                                                            */
/* ------------------------------------------------------------------ */

const FOOTAGE_TOOL: Anthropic.Tool = {
  name: "choose_footage",
  description:
    "Pick one archive clip and write the story to be told over it, or decline if none of them fit.",
  input_schema: {
    type: "object",
    properties: {
      found: { type: "boolean" },
      reason: {
        type: "string",
        description: "Why this clip and this story, or what was missing from the options.",
      },
      key: {
        type: "string",
        description: "The exact key of the chosen clip, e.g. archive:DuckandC1951.",
      },
      startSec: { type: "number", description: "Seconds into the source to start. 0 if unsure." },
      durationSec: { type: "number", description: "Clip length in seconds." },
      hookText: {
        type: "string",
        description:
          "Burned across the upper third. A story premise, max ~60 characters. Never a machine name, never a spec.",
      },
      caption: {
        type: "string",
        description: "The TikTok caption. Carries the whole story. A premise, not a label.",
      },
      hashtags: { type: "array", items: { type: "string" } },
    },
    required: ["found", "reason"],
    additionalProperties: false,
  },
};

export type FootagePick = {
  found: boolean;
  reason: string;
  key?: string;
  startSec?: number;
  durationSec?: number;
  hookText?: string;
  caption?: string;
  hashtags?: string[];
  candidate?: Candidate;
};

/**
 * Picks footage and writes the story told over it.
 *
 * The archives index what is ON SCREEN, not narrative, so the agent supplies
 * the story and the footage is only the visual bed. On this account that
 * distinction is worth 4.7x: footage-led posts median 961 views against 4,539
 * for story-led posts.
 */
export async function findFootage(
  accountId: string,
  angle: string,
  exclude: ReadonlySet<string> = new Set(),
): Promise<FootagePick> {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) throw new Error(`No account ${accountId}`);

  const profile = db
    .select()
    .from(contentProfiles)
    .where(eq(contentProfiles.accountId, accountId))
    .get();

  // Two phrasings: both archives are keyword-matched and one wording often
  // returns nothing usable.
  //
  // The decision often writes several searches in one string, joined by ";" -
  // "B-47 Stratojet takeoff 1950s; Strategic Air Command bomber crew
  // briefing; ...". The archive ANDs every word, so the whole string matched
  // nothing and its first three words ("B-47 Stratojet takeoff") were too
  // narrow for mid-century film: a strong story was declined for no footage
  // twice. Each phrase is tried on its own, then a two-word form of it.
  const phrases = angle.split(/[;|\n]+/).map((p) => p.trim()).filter(Boolean);
  const queries = [
    angle,
    ...phrases,
    ...phrases.map((p) => p.split(/\s+/).filter((w) => !/^\d{4}s?$/.test(w)).slice(0, 2).join(" ")),
    angle.split(/\s+/).slice(0, 3).join(" "),
  ].filter((q, i, all) => q && all.indexOf(q) === i).slice(0, 10);
  // A few from EVERY phrase rather than stopping at the first dozen: stopping
  // early filled the list from "Strategic Air" and "rural South" and the
  // chooser never saw the atomic-bomb films the story actually needed.
  const seen = new Map<string, Candidate>();
  for (const q of queries) {
    let took = 0;
    for (const c of await searchAllSources(accountId, q)) {
      if (took >= 4) break;
      if (!seen.has(c.key) && !exclude.has(c.key)) {
        seen.set(c.key, c);
        took++;
      }
    }
  }

  // One long phrase with no ";" leaves only the whole string and its first
  // words to search, and every word must match: "Operation Plumbbob 1957 Shot
  // John Genie rocket F-89 Scorpion ... Nevada Test Site" found nothing while
  // "Nevada Test" alone finds the atomic films. When the list is thin, the
  // phrase is walked two words at a time.
  if (seen.size < 6) {
    const words = angle
      .split(/[\s;|,]+/)
      .filter((w) => w.length > 2 && !/^\d{4}s?$/.test(w));
    const pairs: string[] = [];
    for (let i = 0; i + 1 < words.length; i++) pairs.push(`${words[i]} ${words[i + 1]}`);
    for (const q of pairs.filter((p) => !queries.includes(p)).slice(0, 12)) {
      if (seen.size >= 12) break;
      let took = 0;
      for (const c of await searchAllSources(accountId, q)) {
        if (took >= 3) break;
        if (!seen.has(c.key) && !exclude.has(c.key)) {
          seen.set(c.key, c);
          took++;
        }
      }
    }
  }

  const candidates = [...seen.values()];
  if (candidates.length === 0) {
    return {
      found: false,
      reason:
        `No public-domain footage found for "${angle}".` +
        (env.dvidsApiKey
          ? ""
          : " Only the Internet Archive was searched - its public-domain collections are mid-century film, so modern hardware will not be there. A DVIDS key would add current DoD material."),
    };
  }

  const listing = candidates
    .map(
      (c) =>
        `key=${c.key} | ${c.source} | ${c.durationSec ? `${Math.round(c.durationSec)}s` : "length unknown"} | ${c.when}\n` +
        `  ${c.title}\n  ${c.description.slice(0, 240)}`,
    )
    .join("\n\n");

  const response = await subscriptionMessagesCreate({
    model: MODELS.strategy,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    system:
      "You choose public-domain footage for one TikTok account and write the story told over it. " +
      "The archives index what is visible on screen, not narrative, so YOU supply the story and the " +
      "footage is only the visual bed. On this account, posts led by a machine or a spec sheet die; " +
      "posts led by an incident, a person, or a conflict perform roughly five times better. " +
      "Never write a caption that is a noun or a label. " +
      "Archive-sourced material is mid-century film - if the angle needs modern hardware and only " +
      "period footage is available, say so and decline rather than shipping a mismatch. " +
      "Your job here is to pick the FILM and write the story - not the timestamp. " +
      "A later step samples frames from whichever film you choose and picks the exact moment by " +
      "looking at them, so choose the film most likely to CONTAIN a usable shot and leave the " +
      "timing to that step. " +
      "Archive films almost always open with 20-40 seconds of title cards and credits, and often " +
      "close with them too. Never start at 0. Start at least 60 seconds in, and prefer the middle " +
      "of the film where the actual footage is.",
    tools: [FOOTAGE_TOOL],
    tool_choice: { type: "tool", name: "choose_footage" },
    messages: [
      {
        role: "user",
        content: [
          `Account: @${account.handle} - ${account.niche}`,
          profile?.toneOfVoice ? `Tone: ${profile.toneOfVoice}` : "",
          "",
          `ANGLE REQUESTED: ${angle}`,
          "",
          "AVAILABLE FOOTAGE",
          listing,
          "",
          "Pick the one clip that can best carry a story, and write that story as the hook and caption.",
          "If nothing here can carry a story worth posting, decline.",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });

  const block = response.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    return { found: false, reason: "The model returned no decision." };
  }

  const choice = block.input as FootagePick;
  return { ...choice, candidate: choice.key ? seen.get(choice.key) : undefined };
}

/* ------------------------------------------------------------------ */
/* Producing                                                           */
/* ------------------------------------------------------------------ */

/**
 * Produces one clip from the archives, end to end.
 *
 * The order matters and is not the obvious one. The film is surveyed *before*
 * the narration is written, so the writer describes footage that exists rather
 * than footage the catalogue implied. The narration is then spoken before any
 * video is fetched, because the spoken timings are what decide how many shots
 * are needed and how long each one runs.
 */
export async function makeDvidsClip(accountId: string, clipId: string) {
  const clip = db.select().from(clips).where(eq(clips.id, clipId)).get();
  if (!clip) throw new Error(`No clip ${clipId}`);

  try {
    setStatus(clipId, "choosing");
    noteProgress(clipId, `Searching public-domain archives for "${clip.sourceUrl}"`);
    // For an archive clip the "source url" field carries the requested angle.
    const angle = clip.sourceUrl;
    const agreedHook = clip.hookText;
    const agreedCaption = clip.caption;
    // A film the picker liked on paper is often wrong once its frames are seen
    // (Mars Bluff: "Airport America" was all crop-dusters). Rejected films are
    // excluded and the next best is tried, a few times, before giving up. A
    // decline also puts the angle back in sourceUrl - the chosen film's URL
    // overwrites it below, and a retry would otherwise search for that film.
    const MAX_FILMS = 3;
    const rejected = new Set<string>();
    const decline = (rationale: string, type: string, message: string) => {
      setStatus(clipId, "declined", { rationale, sourceUrl: angle });
      logEvent({ accountId, level: "info", type, message });
    };
    let chosen: Candidate | undefined;
    let survey: Awaited<ReturnType<typeof surveyFilm>> | undefined;
    let localFile: string | null = null;

    for (let attempt = 1; attempt <= MAX_FILMS; attempt++) {
      const pick = await findFootage(accountId, angle, rejected);
      if (!pick.found || !pick.candidate) {
        const why = rejected.size ? `${pick.reason} (after rejecting ${rejected.size} film(s) on sight)` : pick.reason;
        decline(why, "clip.declined", `No usable footage: ${why}`);
        return;
      }

      const film = pick.candidate;
      noteProgress(clipId, `Chose the film "${film.title}" (${film.when})`);

      setStatus(clipId, "looking", {
        dvidsId: film.source === "dvids" ? film.dvids?.id : film.archive?.id,
        sourceUrl: film.pageUrl,
        sourceTitle: film.title,
        sourceUploader: film.credit,
        sourceDurationSec: film.durationSec,
        rationale: pick.reason,
      });

      /* ------------------------------------------------------------ */
      /* 1. Look at the film                                           */
      /* ------------------------------------------------------------ */

      // A DVIDS asset is short and purpose-shot, so it is fetched whole and cut
      // on disk. Archive films run past twenty minutes, so they are sampled over
      // HTTP range requests and only the chosen shots are ever downloaded.
      let file: string | null = null;
      let filmLength = film.durationSec ?? 0;

      if (film.source === "dvids" && film.dvids) {
        const asset = film.dvids.downloadUrl
          ? film.dvids
          : ((await getAsset(film.dvids.id)) ?? film.dvids);
        file = await downloadAsset(asset, clipId);
        filmLength = (await probe(file)).durationSec;
      } else {
        const probed = await probeRemoteDuration(film.pageUrl);
        if (!probed || probed <= 0) {
          noteProgress(clipId, `Could not tell how long "${film.title}" is - trying another film`);
          rejected.add(film.key);
          continue;
        }
        filmLength = probed;
      }

      noteProgress(
        clipId,
        `Sampling frames across ${Math.round(filmLength / 60)} minutes of film to see what is actually in it`,
      );

      const looked = await surveyFilm(accountId, film.pageUrl, filmLength, angle);
      if (!looked.found || looked.moments.length === 0) {
        noteProgress(clipId, `Looked at the footage and rejected it: ${looked.reason}`);
        logEvent({
          accountId,
          level: "info",
          type: "clip.rejected_on_sight",
          message: `Rejected "${film.title}" after looking: ${looked.reason}`,
        });
        rejected.add(film.key);
        if (file) {
          try {
            fs.unlinkSync(file);
          } catch {
            // Not fatal.
          }
        }
        if (attempt === MAX_FILMS) {
          decline(
            `Looked at ${MAX_FILMS} films and none fit. Last: ${looked.reason}`,
            "clip.declined_on_sight",
            `Rejected ${MAX_FILMS} films on sight for "${angle.slice(0, 80)}"`,
          );
          return;
        }
        continue;
      }

      chosen = film;
      survey = looked;
      localFile = file;
      break;
    }

    if (!chosen || !survey) {
      decline("No film could be sampled.", "clip.declined", `No film could be sampled for "${angle.slice(0, 80)}"`);
      return;
    }

    noteProgress(clipId, `Found ${survey.moments.length} usable shots. ${survey.summary}`);
    logEvent({
      accountId,
      type: "shots.surveyed",
      message: `${survey.moments.length} moments in "${chosen.title}": ${survey.summary}`,
    });

    /* -------------------------------------------------------------- */
    /* 2. Write it, then speak it                                      */
    /* -------------------------------------------------------------- */

    setStatus(clipId, "scripting");
    noteProgress(clipId, "Writing the narration for what I can see in the footage");

    const script = await writeScript(
      accountId,
      angle,
      { title: chosen.title, description: survey.summary, year: chosen.when },
      // Captured before this step overwrites them. On the chat path these hold
      // the hook and caption the owner actually signed off on; on the
      // autonomous path hookText is the angle, which serves as direction just
      // as well.
      { hookText: agreedHook, caption: agreedCaption },
    );

    // The writer overruns its word budget often enough that this cannot be
    // left to the prompt alone.
    const budgetSec = sourceWindowSec(accountId).maxSec;
    const spoken = trimToBudget(script.lines, budgetSec);
    if (spoken.length < script.lines.length) {
      noteProgress(
        clipId,
        `Cut ${script.lines.length - spoken.length} line(s) to keep it under ${budgetSec} seconds`,
      );
    }

    setStatus(clipId, "voicing", {
      script: JSON.stringify(spoken),
      openLoop: script.openLoop,
      look: JSON.stringify(script.look),
      hookText: script.hookText,
      caption: script.caption,
      hashtags: JSON.stringify(script.hashtags),
    });
    noteProgress(clipId, `Recording ${spoken.length} lines of narration`);

    const narration = await speak(clipId, spoken);
    noteProgress(
      clipId,
      `Narration is ${(narration.durationMs / 1000).toFixed(0)}s - that sets the length of the video`,
    );

    /* -------------------------------------------------------------- */
    /* 3. Cut the picture to the voice                                 */
    /* -------------------------------------------------------------- */

    // The script named words; the narrator decided when they land. Resolving
    // here rather than guessing means an effect hits the syllable rather than
    // a timestamp somebody estimated.
    const hits = resolveHits(script.hits, narration.words);
    if (hits.length > 0) {
      noteProgress(
        clipId,
        `Firing ${hits.map((h) => h.effect).join(", ")} on the words that carry the story`,
      );
    }

    const planned = await assignShots(spoken, narration.lines, survey.moments);
    if (planned.length === 0) {
      throw new Error("No shots could be assigned to the narration.");
    }

    // The first picture is the event itself, when the film has it. The shot
    // list follows the narration, which opens on set-up - so the Bikini story
    // began on a cloud bank and reached its explosion at 58 seconds, long
    // after anyone deciding in the first second had gone. The blast returns
    // where the story reaches it; seen twice, it is a cold open.
    const strongest = survey.moments
      .filter((m) => m.energy === "violent")
      .sort((a, b) => b.atSec - a.atSec)[0];
    if (strongest && planned[0].atSec !== strongest.atSec) {
      planned[0] = { ...planned[0], atSec: strongest.atSec, whatIsVisible: strongest.whatIsVisible };
      noteProgress(clipId, `Opening on the strongest footage: ${strongest.whatIsVisible}`);
    }

    setStatus(clipId, "downloading", {
      words: JSON.stringify(narration.words),
      shots: JSON.stringify(planned),
      hits: JSON.stringify(hits),
      voicePath: narration.audioPath,
      startSec: Math.min(...planned.map((p) => p.atSec)),
      endSec: Math.max(...planned.map((p) => p.atSec)),
    });
    noteProgress(clipId, `Pulling ${planned.length} separate shots out of the film`);

    const fetched = await fetchShots(chosen.pageUrl, clipId, planned, {
      localFile: localFile ?? undefined,
    });

    // A failed shot is first retried from a DIFFERENT part of the film before
    // any shot is reused. The old backfill went straight to copying another
    // surviving shot, which is how an edit that planned nine pictures ends up
    // showing one - each failure duplicated a survivor, and failures cluster
    // when the archive throttles. Retrying at unused surveyed moments costs
    // one more range request per failure and keeps the edit varied.
    const failed = fetched
      .map((f, i) => (f ? null : i))
      .filter((i): i is number => i !== null);
    if (failed.length > 0) {
      // Moments no surviving shot already covers, furthest from everything
      // used so the retries land on fresh material.
      const takenAt = new Set(
        fetched.filter(Boolean).map((f, i) => planned[i].atSec),
      );
      const free = survey.moments.filter((m) => !takenAt.has(m.atSec));
      const retries: Array<{ atSec: number; startMs: number; endMs: number }> = [];
      for (let k = 0; k < failed.length && free.length > 0; k++) {
        const i = failed[k];
        // Pick the free moment furthest from the nearest used one.
        let best = 0;
        let bestDistance = -1;
        for (let j = 0; j < free.length; j++) {
          const distance = Math.min(
            ...[...takenAt].map((t) => Math.abs(t - free[j].atSec)),
            Infinity,
          );
          if (distance > bestDistance) {
            bestDistance = distance;
            best = j;
          }
        }
        const moment = free.splice(best, 1)[0];
        takenAt.add(moment.atSec);
        planned[i] = { ...planned[i], atSec: moment.atSec, whatIsVisible: moment.whatIsVisible };
        retries.push({ atSec: moment.atSec, startMs: planned[i].startMs, endMs: planned[i].endMs });
      }
      if (retries.length > 0) {
        noteProgress(clipId, `Retrying ${retries.length} shot(s) from other parts of the film`);
        const again = await fetchShots(chosen.pageUrl, `${clipId}-r`, retries, {
          localFile: localFile ?? undefined,
        });
        for (let k = 0; k < failed.length; k++) {
          if (again[k]) fetched[failed[k]] = again[k];
        }
      }
    }

    // Counted before the backfill below. Counting after it would report nine
    // usable shots when the edit actually holds two pictures repeated, which
    // is the exact failure this whole rewrite exists to remove.
    const distinct = new Set(fetched.filter(Boolean).map((f) => f!.path)).size;

    // Shots that came back black, blown out or featureless have to be
    // replaced, and *what* replaces them matters. The obvious move - grab a
    // moment the edit did not use - is wrong: those moments went unused
    // because they do not fit the story, so it fills the hole with a submarine
    // while the narration is talking about a deck crew. Reusing a shot that
    // already survived keeps the picture on the subject; a repeat separated by
    // twenty seconds and given a different move reads as coverage, whereas a
    // non-sequitur reads as a mistake.
    for (let i = 0; i < fetched.length; i++) {
      if (fetched[i]) continue;

      let best: number | null = null;
      let bestDistance = -1;
      for (let k = 0; k < fetched.length; k++) {
        if (!fetched[k]) continue;
        const distance = Math.abs(k - i);
        if (distance > bestDistance) {
          bestDistance = distance;
          best = k;
        }
      }
      if (best === null) continue;

      fetched[i] = fetched[best];
      // Never repeat the move as well as the picture, or the reuse is obvious.
      // A softer blend helps too - a hard cut draws the eye straight to the
      // fact that this shot has been seen already.
      planned[i] = {
        ...planned[i],
        move: alternateMove(planned[best].move),
        transition: planned[i].transition === "cut" ? "glide" : planned[i].transition,
      };
    }

    logEvent({
      accountId,
      level: distinct < 4 ? "warn" : "info",
      type: "shots.fetched",
      message: `${distinct} distinct picture(s) for ${planned.length} shots`,
    });
    if (distinct < 4) {
      noteProgress(
        clipId,
        `Only ${distinct} shot(s) came back usable - the edit will repeat itself`,
      );
    }

    // A shot that failed to download leaves a hole. Rather than losing the
    // render, the previous shot is held over it - the cut is lost but the
    // narration stays in sync, which matters more.
    const shots: Array<{
      path: string;
      startMs: number;
      endMs: number;
      move: Move;
      transition: Transition;
      transitionMs: number;
    }> = [];
    let lastGood: string | null = null;
    for (let i = 0; i < planned.length; i++) {
      const file: string | null = fetched[i]?.path ?? lastGood;
      if (!file) continue;
      lastGood = file;
      shots.push({
        path: file,
        startMs: planned[i].startMs,
        endMs: planned[i].endMs,
        move: planned[i].move,
        transition: planned[i].transition,
        transitionMs: planned[i].transitionMs,
      });
    }
    // Anything that failed before the first success has no footage to hold, so
    // pull the first surviving shot back to the start of the video.
    if (shots.length > 0 && shots[0].startMs > 0) shots[0].startMs = 0;
    // Nothing precedes the opener, so it can only cut.
    if (shots.length > 0) {
      shots[0] = { ...shots[0], transition: "cut", transitionMs: 0 };
    }

    if (shots.length === 0) {
      throw new Error("None of the chosen shots could be downloaded.");
    }
    if (localFile) {
      try {
        fs.unlinkSync(localFile);
      } catch {
        // The whole-asset download is large but a leftover is not fatal.
      }
    }

    /* -------------------------------------------------------------- */
    /* 4. Render                                                       */
    /* -------------------------------------------------------------- */

    setStatus(clipId, "editing", { rawPath: shots[0].path });

    const track = pickTrack(script.musicMood);

    // For After Effects the picture goes over as a plain pre-cut: the shots,
    // their moves and the narration, with nothing drawn on top. The editor
    // transcribes that narration and cuts, captions and treats it itself, so a
    // hook, captions or effects burned in here would be drawn twice. Sound
    // effects and the bed are held back too - its story pass would chop a
    // baked-in bed at every join - and the bed goes under the finished edit as
    // a layer of its own instead.
    if (useAeEditor()) {
      noteProgress(
        clipId,
        `Assembling ${shots.length} shots under the narration for the After Effects editor`,
      );
      const precut = await renderClip(`${clipId}-precut`, {
        shots,
        words: narration.words,
        lines: narration.lines,
        hookText: "",
        voicePath: narration.audioPath,
        durationMs: narration.durationMs,
        hits: [],
        look: {
          ...script.look,
          captions: "none",
          chrome: [],
          stamps: [],
          motion: { lightLeak: false, vignette: false, speedRamp: false },
        },
      });
      setStatus(clipId, "editing", { rawPath: precut, musicPath: track?.path ?? null });
      const payload: AeEditPayload = {
        clipId,
        sourcePath: precut,
        // The narration IS the story, written to this account's length: edit
        // all of it. Cut to aeTargetSec it lost its ending, and at the global
        // 30s cap a 61s+ story for a monetized account came out unmonetizable.
        targetSec: Math.ceil(narration.durationMs / 1000),
        keepAll: true,
        // A narrated archive story is carried by its pictures: the film is a
        // generic reel, the public-domain photographs make it THIS story. The
        // measured rate is for talking heads and left Mars Bluff with none.
        appetite: 3,
        musicPath: track?.path ?? null,
      };
      enqueue({ accountId, type: "edit_ae", payload });
      noteProgress(clipId, "Pre-cut ready - queued for the After Effects editor");

      // The short version of the same story, for accounts that asked for one.
      // It is a second video in its own right, so failing to make it must
      // never cost the long one that is already queued.
      try {
        const { makeTeaser, teaserEnabled } = await import("./teaser");
        if (teaserEnabled(accountId)) {
          const teaserId = await makeTeaser(accountId, {
            parentClipId: clipId,
            angle: agreedHook || angle,
            narration: spoken.map((l) => l.text),
            film: { title: chosen.title, pageUrl: chosen.pageUrl, credit: chosen.credit, when: chosen.when },
            moments: survey.moments,
            // The whole-asset download was deleted above once its shots were cut.
            localFile: null,
          });
          noteProgress(clipId, `Short version made as ${teaserId} - sent for review`);
        }
      } catch (err) {
        logEvent({
          accountId,
          level: "warn",
          type: "teaser.failed",
          message: `No short version this time: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      return;
    }
    noteProgress(
      clipId,
      track
        ? `Cutting ${shots.length} shots to the narration, over "${track.name}"`
        : `Cutting ${shots.length} shots to the narration`,
    );

    // The mixed track replaces raw narration: effects on cuts and hits, and
    // a bed that ducks under the voice, are baked in by the time Remotion
    // sees it. With no music and no effects this is a pass-through.
    const sound = planSoundDesign(shots, hits, clipId);
    const soundtrack = await buildSoundtrack(
      clipId,
      {
        narrationPath: narration.audioPath,
        musicPath: track?.path ?? null,
        seed: clipId,
      },
      sound,
    );
    if (soundtrack !== narration.audioPath) {
      noteProgress(clipId, `Mixed ${sound.length} sound effect(s) under the narration`);
    }

    const outputPath = await renderClip(clipId, {
      shots,
      words: narration.words,
      lines: narration.lines,
      hookText: script.hookText,
      voicePath: soundtrack,
      // The bed is already inside the mix; handing it over again would
      // double it.
      durationMs: narration.durationMs,
      hits,
      look: script.look,
    });
    const edited = { path: outputPath, probe: await probe(outputPath) };

    // A missing preview image must never cost you a finished video.
    let thumb: string | null = null;
    try {
      thumb = await extractThumbnail(edited.path, clipId);
    } catch (err) {
      logEvent({
        accountId,
        level: "warn",
        type: "clip.no_thumbnail",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    setStatus(clipId, "ready", {
      outputPath: edited.path,
      thumbnailPath: thumb,
      outputDurationSec: edited.probe.durationSec,
      sizeBytes: edited.probe.sizeBytes,
      musicPath: track?.path ?? null,
      error: null,
    });

    logEvent({
      accountId,
      level: "success",
      type: "clip.ready",
      message: `Cut ${edited.probe.durationSec.toFixed(0)}s from ${chosen.source} in ${shots.length} shots - ${script.hookText}`,
    });
    noteProgress(
      clipId,
      `Done - ${Math.round(edited.probe.durationSec)}s, ${shots.length} shots, narrated. Ready to download`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus(clipId, "failed", { error: message });
    logEvent({ accountId, level: "error", type: "clip.failed", message });
    throw err;
  }
}

/**
 * A different move for a reused shot.
 *
 * Repeating the picture is survivable; repeating the picture *and* the camera
 * move is what makes a repeat visible.
 */
function alternateMove(move: Move): Move {
  const swap: Record<Move, Move> = {
    push: "pull",
    pull: "push",
    driftL: "driftR",
    driftR: "driftL",
    hold: "push",
    punch: "push",
  };
  return swap[move] ?? "push";
}
