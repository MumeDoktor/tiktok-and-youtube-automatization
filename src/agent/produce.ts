import { and, desc, eq, ne } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "@/db";
import { accounts, clips, contentProfiles, posts } from "@/db/schema";
import { anthropic } from "@/lib/anthropic";
import { env, MODELS } from "@/lib/env";
import { latestAnalysis, loadVideos, computeStats } from "./account-analysis";
import { formatSlot, type AutopilotPayload } from "./autopilot";
import { logEvent, noteProgress } from "./events";
import { notify } from "./notify";
import { schedulePublish } from "./publish";
import { makeDvidsClip } from "./footage";
import { makeClip } from "./clip";
import { findSource, type SourceHint } from "./source";

/* ------------------------------------------------------------------ */
/* Deciding what to make                                               */
/* ------------------------------------------------------------------ */

const DECIDE_TOOL: Anthropic.Tool = {
  name: "decide_next_video",
  description:
    "Decide what video to make next for this account, and justify it from the account's own numbers.",
  input_schema: {
    type: "object",
    properties: {
      format: {
        type: "string",
        enum: ["interview", "archive"],
        description:
          "Where the video comes from. interview: a clip cut from a long YouTube interview or podcast, in the speaker's own voice - the only way to get a named person telling their story. archive: narration written over public-domain footage - only for a story that the archive's footage can actually show.",
      },
      angle: {
        type: "string",
        description:
          "The story to tell, in one line. For interview, name the person and the story they tell. For archive, name something filmable - an aircraft, a unit, an operation - as well as the story.",
      },
      searchTerms: {
        type: "string",
        description:
          "For interview: what you would type into YouTube to find a long interview where this story is told, e.g. 'John McPhee Delta Force podcast'. For archive: what is ON SCREEN, not the narrative, e.g. 'B-29 bomber takeoff 1945'.",
      },
      why: {
        type: "string",
        description:
          "Why this video, now. Cite specific numbers from this account. 3-5 sentences. This is shown to the owner as the justification, so it must be concrete, not generic.",
      },
      evidence: {
        type: "array",
        items: { type: "string" },
        description:
          "2-4 specific data points supporting the choice, each naming a real figure from the account.",
      },
      expectation: {
        type: "string",
        description:
          "What you expect this to do, stated as a number to check against later. e.g. 'should clear the 2,336 median; a win is above 20,000'.",
      },
      avoids: {
        type: "string",
        description: "What failing pattern this deliberately steers away from.",
      },
    },
    required: ["format", "angle", "searchTerms", "why", "evidence", "expectation", "avoids"],
    additionalProperties: false,
  },
};

/** What the footage archive can show, which depends on whether DVIDS is configured. */
function archiveReach(): string {
  return env.dvidsApiKey
    ? "archive: public-domain US military footage - DVIDS (modern DoD video of aircraft, units " +
        "and exercises) plus the Internet Archive's mid-century films."
    : "archive: ONLY the Internet Archive's public-domain films, which are mid-century " +
        "(roughly 1930s-1960s) - WWII and early Cold War aircraft, newsreels, training and civil " +
        "defence films. No DVIDS key is configured, so there is no modern footage at all.";
}

export type Decision = {
  format: "interview" | "archive";
  angle: string;
  searchTerms: string;
  why: string;
  evidence: string[];
  expectation: string;
  avoids: string;
};

/**
 * Decides what to make next, unprompted.
 *
 * Everything it cites is measured from the account, so the justification the
 * owner reads is checkable rather than plausible-sounding.
 */
export async function decideNextVideo(accountId: string): Promise<Decision> {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) throw new Error(`No account ${accountId}`);

  const profile = db
    .select()
    .from(contentProfiles)
    .where(eq(contentProfiles.accountId, accountId))
    .get();

  const analysis = latestAnalysis(accountId);
  const stats = computeStats(loadVideos(accountId), account.timezone);

  // What has already been posted, and what has already been produced here -
  // so it does not propose the same thing twice.
  const recentCaptions = db
    .select({ caption: posts.caption })
    .from(posts)
    .where(eq(posts.accountId, accountId))
    .orderBy(desc(posts.publishedAt))
    .limit(25)
    .all()
    .map((p) => p.caption)
    .filter(Boolean);

  const alreadyMade = db
    .select({ angle: clips.sourceUrl, hook: clips.hookText })
    .from(clips)
    // Skips the row of the video being decided right now, which has no angle yet.
    .where(and(eq(clips.accountId, accountId), ne(clips.sourceUrl, "")))
    .orderBy(desc(clips.createdAt))
    .limit(15)
    .all();

  let read = "";
  if (analysis?.rawAnalysis) {
    try {
      const parsed = JSON.parse(analysis.rawAnalysis) as {
        read?: { summary?: string; whatWorks?: string[]; whatToFix?: string[] };
      };
      const lines: string[] = [];
      if (parsed.read?.summary) lines.push(parsed.read.summary);
      if (parsed.read?.whatWorks?.length) {
        lines.push("", "What works:");
        for (const w of parsed.read.whatWorks) lines.push(`- ${w}`);
      }
      if (parsed.read?.whatToFix?.length) {
        lines.push("", "What is failing:");
        for (const w of parsed.read.whatToFix) lines.push(`- ${w}`);
      }
      read = lines.join("\n");
    } catch {
      read = "";
    }
  }

  const response = await anthropic().messages.create({
    model: MODELS.strategy,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    system:
      "You decide what one TikTok video to make next for a single account, working only from that " +
      "account's measured performance. Every number you cite must come from the data given to you. " +
      "A video comes from one of two sources, and each can only deliver what it holds:\n" +
      "- interview: long-form interviews and podcasts on YouTube, cut down to one story told in " +
      "the speaker's own voice. The way to feature a named person.\n" +
      `- ${archiveReach()}\n` +
      "Pick the source that can actually supply the story. A modern named operator's story " +
      "cannot be told over archive film - that pairing finds no footage and is declined. " +
      "The owner reads your justification and decides whether to trust it, so be specific and honest, " +
      "including about what you are unsure of.",
    tools: [DECIDE_TOOL],
    tool_choice: { type: "tool", name: "decide_next_video" },
    messages: [
      {
        role: "user",
        content: [
          `Account: @${account.handle} - ${account.niche}`,
          profile?.description ? `Format: ${profile.description}` : "",
          profile?.toneOfVoice ? `Tone: ${profile.toneOfVoice}` : "",
          "",
          "MEASURED PERFORMANCE",
          `Videos: ${stats.videoCount} · median ${stats.medianViews.toLocaleString()} views · best ${stats.bestViews.toLocaleString()}`,
          `Recent 10 median ${stats.recent10MedianViews.toLocaleString()} vs previous 10 ${stats.previous10MedianViews.toLocaleString()}` +
            (stats.trendPct !== null ? ` (${stats.trendPct > 0 ? "+" : ""}${stats.trendPct}%)` : ""),
          `Engagement rate ${stats.engagementRate}% of views`,
          "",
          "Length vs median views:",
          ...stats.durationStats.map(
            (d) => `- ${d.label}: ${d.medianViews.toLocaleString()} (n=${d.n})`,
          ),
          "",
          read ? `THE STANDING READ OF THIS ACCOUNT\n${read}` : "",
          "",
          "ALREADY POSTED (do not repeat these):",
          ...recentCaptions.map((c) => `- ${c.slice(0, 90)}`),
          "",
          alreadyMade.length
            ? `ALREADY PRODUCED HERE (do not repeat):\n${alreadyMade
                .map((c) => `- ${c.hook ?? c.angle}`)
                .join("\n")}`
            : "",
          "",
          "Decide the single next video and where it comes from. It must be a story rather than a machine or a spec, and the source you pick must be able to supply it.",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });

  const block = response.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error("The agent returned no decision.");
  }
  return block.input as Decision;
}

/* ------------------------------------------------------------------ */
/* One button                                                          */
/* ------------------------------------------------------------------ */

/**
 * The whole loop, unattended: decide what to make, justify it, find footage,
 * cut it. The owner reads the reasoning and either uses the clip or argues
 * with it in chat.
 */
export async function produceNext(
  accountId: string,
  { scheduledFor }: { scheduledFor?: Date } = {},
) {
  // The row exists from the first second, so the owner sees the video start
  // instead of an empty list for the minute or two the decision takes.
  const clip = db
    .insert(clips)
    .values({
      accountId,
      sourceType: "dvids",
      sourceUrl: "",
      status: "deciding",
      scheduledFor: scheduledFor ?? null,
    })
    .returning()
    .get();
  noteProgress(clip.id, "Deciding what to make next from this account's numbers");

  let decision: Decision;
  try {
    decision = await decideNextVideo(accountId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.update(clips).set({ status: "failed", error: message }).where(eq(clips.id, clip.id)).run();
    throw err;
  }

  logEvent({
    accountId,
    level: "info",
    type: "produce.decided",
    message: `Next video: ${decision.angle}`,
    meta: decision,
  });

  const rationale = [
    decision.why,
    "",
    "Evidence:",
    ...decision.evidence.map((e) => `- ${e}`),
    "",
    `Expectation: ${decision.expectation}`,
    `Avoids: ${decision.avoids}`,
  ].join("\n");

  // The row carries the decision before any source is searched, so the
  // reasoning is visible while the footage is still downloading - and
  // survives a failure further down the pipeline.
  if (decision.format === "interview") {
    db.update(clips)
      .set({ status: "choosing", sourceType: "url", rationale, hookText: decision.angle })
      .where(eq(clips.id, clip.id))
      .run();
    noteProgress(clip.id, `Decided: ${decision.angle} - cut from an interview`);

    try {
      await producePodcastClips(accountId, { clipId: clip.id, hint: decision });
    } catch (err) {
      // makeClip marks its own failures. This catches the search before it,
      // which would otherwise leave the row spinning on "choosing" for good.
      db.update(clips)
        .set({ status: "failed", error: err instanceof Error ? err.message : String(err) })
        .where(and(eq(clips.id, clip.id), eq(clips.status, "choosing")))
        .run();
      throw err;
    }
    return { clipId: clip.id, decision };
  }

  db.update(clips)
    .set({
      status: "queued",
      // findFootage reads the angle from here until an asset is chosen.
      sourceUrl: decision.searchTerms,
      rationale,
      hookText: decision.angle,
    })
    .where(eq(clips.id, clip.id))
    .run();
  noteProgress(clip.id, `Decided: ${decision.angle} - narrated over archive footage`);

  await makeDvidsClip(accountId, clip.id);
  return { clipId: clip.id, decision };
}

/**
 * Tells the owner how a video asked for by hand came out.
 *
 * A declined video used to end silently, which from the button looks exactly
 * like nothing having happened. An edit handed to After Effects reports for
 * itself, so only the endings here are covered.
 */
export function reportProduced(accountId: string, clipId: string) {
  const clip = db.select().from(clips).where(eq(clips.id, clipId)).get();
  if (!clip) return;
  const hook = clip.hookText || "Your video";

  if (clip.status === "ready") {
    notify({
      accountId,
      level: "success",
      type: "produce.ready",
      title: "Video ready",
      body:
        `${hook}` +
        (clip.outputDurationSec ? ` (${Math.round(clip.outputDurationSec)}s)` : "") +
        ". Download it from the account page.",
      meta: { clipId },
    });
  } else if (clip.status === "declined") {
    notify({
      accountId,
      level: "warn",
      type: "produce.declined",
      title: "No video this time",
      body: (clip.rationale ?? "Nothing usable was found.").split(/(?<=\.)\s/)[0],
      meta: { clipId },
    });
  } else if (clip.status === "failed") {
    notify({
      accountId,
      level: "error",
      type: "produce.failed",
      title: "Video failed",
      body: clip.error ?? "Unknown error",
      meta: { clipId },
    });
  }
}

/**
 * Ideas tried per slot. Finding no usable footage is a common, cheap outcome,
 * and a second decision differs from the first because the declined one is now
 * in the already-produced list it is told not to repeat.
 */
const SLOT_TRIES = 2;

/**
 * Makes the video for one autopilot slot and tells the owner when it is done.
 *
 * Never throws for a production that went wrong: the owner is notified, and
 * the worker plans the next slot as soon as this returns. Retrying a render
 * into the slot it was meant for would only make it late.
 */
export async function produceForSlot(accountId: string, payload: AutopilotPayload) {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) throw new Error(`No account ${accountId}`);
  if (!account.autopilot) return;

  const slot = new Date(payload.slotAt);
  const when = formatSlot(slot, account.timezone);

  // Only after an outage long enough to swallow the whole lead time. A video
  // for a slot already gone is not what was planned; the next slot is.
  if (Date.now() >= slot.getTime()) {
    logEvent({
      accountId,
      level: "warn",
      type: "autopilot.missed",
      message: `Skipped the ${when} video - the worker was not running in time to make it.`,
    });
    return;
  }

  logEvent({
    accountId,
    type: "autopilot.started",
    message: `Making the video for ${when}. ${payload.why}`,
  });

  for (let attempt = 1; attempt <= SLOT_TRIES; attempt++) {
    let clipId: string;
    try {
      ({ clipId } = await produceNext(accountId, { scheduledFor: slot }));
    } catch (err) {
      notify({
        accountId,
        level: "error",
        type: "autopilot.failed",
        title: `No video for ${when}`,
        body: `Production failed: ${err instanceof Error ? err.message : String(err)}`,
        meta: { slotAt: payload.slotAt },
      });
      return;
    }

    const clip = db.select().from(clips).where(eq(clips.id, clipId)).get();

    if (clip?.status === "ready") {
      schedulePublish(clipId);
      notify({
        accountId,
        level: "success",
        type: "autopilot.ready",
        title: `Video ready - post at ${when}`,
        body:
          `${clip.hookText ?? "Your video"}` +
          (clip.outputDurationSec ? ` (${Math.round(clip.outputDurationSec)}s)` : "") +
          ". Caption and hashtags are on the account page.",
        meta: { clipId, slotAt: payload.slotAt },
      });
      return;
    }

    // A source that turned out to be live or captionless fails without throwing.
    if (clip?.status === "failed") {
      notify({
        accountId,
        level: "error",
        type: "autopilot.failed",
        title: `No video for ${when}`,
        body: `Production failed: ${clip.error ?? "unknown error"}`,
        meta: { clipId, slotAt: payload.slotAt },
      });
      return;
    }

    // Handed to After Effects. ae-edit tells the owner when the edit is built
    // and when the export lands, both with the posting time on them.
    if (clip?.status !== "declined") return;

    if (Date.now() >= slot.getTime()) break;
    logEvent({
      accountId,
      type: "autopilot.retry",
      message: `Nothing usable for the ${when} idea - deciding again (${attempt}/${SLOT_TRIES}).`,
    });
  }

  notify({
    accountId,
    level: "warn",
    type: "autopilot.declined",
    title: `No video for ${when}`,
    body: `Tried ${SLOT_TRIES} ideas and none found anything usable to cut. The next slot is planned as usual.`,
    meta: { slotAt: payload.slotAt },
  });
}

/**
 * The same loop, from an interview instead of the archive.
 *
 * Nothing is pasted in: the agent works out what this account should be
 * cutting from, searches YouTube for it, and hands the winner to makeClip,
 * which reads the whole transcript and cuts what is worth posting.
 *
 * Most interviews hold nothing that stands alone, so "nothing worth cutting"
 * is the ordinary answer rather than a fault - which is exactly why one read is
 * not enough. A decline sends it back to the search for another interview, up
 * to SOURCE_TRIES of them, because stopping at the first turns a normal answer
 * into a request that produced nothing.
 *
 * Returns null when every source tried was empty, which is still a real
 * outcome and not an error: no video is better than a bad one.
 */
export async function producePodcastClips(
  accountId: string,
  {
    clipId,
    hint,
    tries = env.sourceTries,
  }: {
    /** A row already carrying the decision to make this video, to fill in rather than add. */
    clipId?: string;
    /** The story already decided on, which the search aims at. */
    hint?: SourceHint;
    /** How many interviews to read before giving up. */
    tries?: number;
  } = {},
) {
  // The decision this row was created with. makeClip overwrites rationale with
  // the reason for the beat it picked, so it has to be put back before a retry.
  const decided = clipId ? db.select().from(clips).where(eq(clips.id, clipId)).get() : null;
  const attempts = Math.max(1, tries);
  const tried: string[] = [];
  let lastReason = "";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (clipId) {
      noteProgress(
        clipId,
        attempt === 1
          ? "Searching YouTube for a long interview where this story is told"
          : `Looking for another interview (${attempt} of ${attempts})`,
      );
    }

    // Sources already read are excluded, so each attempt gets a new one rather
    // than the same best-looking candidate every time.
    const pick = await findSource(accountId, hint, tried);

    if (!pick) {
      const message = hint
        ? `Searched YouTube for an interview behind "${hint.angle}" and found none left that is long enough and has captions.`
        : "Searched for an interview to cut and found nothing usable this time.";
      logEvent({ accountId, level: "info", type: "produce.no_source", message });
      if (clipId) {
        db.update(clips)
          .set({
            status: "declined",
            rationale: lastReason ? `${message}\n\nThe last one read: ${lastReason}` : message,
          })
          .where(eq(clips.id, clipId))
          .run();
      }
      return null;
    }

    logEvent({
      accountId,
      level: "info",
      type: "produce.source_found",
      message: `Cutting from "${pick.title}" (${Math.round(pick.durationSec / 60)}min, ${pick.uploader ?? "unknown"})`,
      meta: pick,
    });

    const source = {
      sourceType: "url" as const,
      sourceUrl: pick.url,
      sourceTitle: pick.title,
      sourceUploader: pick.uploader,
      sourceDurationSec: pick.durationSec,
    };

    // The row carries the reasoning from the start, so the owner can see why
    // this source was chosen even while the transcript is still being read. A
    // row that arrived already decided keeps the reason for the video; the
    // reason for this source goes into its progress trail below.
    const clip = clipId
      ? db.update(clips).set(source).where(eq(clips.id, clipId)).returning().get()
      : db.insert(clips).values({ accountId, ...source, rationale: pick.why }).returning().get();
    if (!clip) throw new Error(`No clip ${clipId}`);

    // makeClip replaces rationale with the reason for the beat it picks, which
    // is the right thing for a finished clip to carry - but it would take the
    // reason this SOURCE was chosen down with it. The progress trail is append
    // -only, so putting it there keeps both halves of the decision.
    noteProgress(
      clip.id,
      `Chose "${pick.title}" (${Math.round(pick.durationSec / 60)}min, ${pick.uploader ?? "unknown"}) - ${pick.why.split("\n")[0]}`,
    );
    tried.push(pick.url);

    await makeClip(accountId, clip.id);

    const after = db.select().from(clips).where(eq(clips.id, clip.id)).get();
    if (after?.status !== "declined") return { clipId: clip.id, source: pick };

    lastReason = after.rationale ?? "";
    const summary = lastReason.split(/(?<=\.)\s/)[0];
    logEvent({
      accountId,
      type: "produce.source_declined",
      message:
        `Nothing worth cutting in "${pick.title}"` +
        (attempt < attempts ? " - looking for another interview" : ""),
    });

    if (!clipId) continue;

    if (attempt < attempts) {
      // Back to searching, with the decision's own reasoning restored and the
      // read source cleared off the row.
      db.update(clips)
        .set({
          status: "choosing",
          rationale: decided?.rationale ?? null,
          transcript: null,
          startSec: null,
          endSec: null,
          error: null,
        })
        .where(eq(clips.id, clip.id))
        .run();
      noteProgress(clip.id, `Read "${pick.title}" and found nothing worth cutting: ${summary}`);
    } else {
      db.update(clips)
        .set({
          rationale:
            `Read ${tried.length} interview(s) and none held a story that stands on its own.\n\n` +
            `The last one: ${lastReason}`,
        })
        .where(eq(clips.id, clip.id))
        .run();
    }
  }

  return null;
}
