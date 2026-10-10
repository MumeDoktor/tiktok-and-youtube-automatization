import fs from "node:fs";
import path from "node:path";

import { eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "@/db";
import { accounts, clips, settings } from "@/db/schema";
import { subscriptionMessagesCreate } from "@/lib/claude-subscription";
import { env, MODELS } from "@/lib/env";
import { extractThumbnail, outDir, probe, rawDir, resolveMediaUrl, run, splitCmd } from "@/lib/media";
import { logEvent, noteProgress } from "./events";
import type { FilmMoment } from "./shots";
import { sendForReview } from "./telegram-review";

/**
 * A short visual story. Four beats reveal one fact at a time over four distinct
 * archival moments. A single 50-word card on an eight-second loop made the
 * viewer read the payoff immediately while the picture barely changed.
 *
 * On per account: `teaser:<accountId>` = "1" in the settings table.
 */

export function teaserEnabled(accountId: string): boolean {
  const row = db.select().from(settings).where(eq(settings.key, `teaser:${accountId}`)).get();
  return row?.value === "1";
}

const TEASER_TOOL: Anthropic.Tool = {
  name: "write_story_card",
  description: "Write four short sequential story beats and assign a relevant archive shot to each.",
  input_schema: {
    type: "object",
    properties: {
      beats: {
        type: "array",
        description:
          "Exactly four beats in story order: hook, setup, turn, consequence. Each is 4-9 words, one readable thought. Reveal the outcome only in the final beat. Choose a different film moment for each beat where possible.",
        items: {
          type: "object",
          properties: {
            text: { type: "string", description: "4-9 words of on-screen text. No paragraph or second sentence." },
            moment: { type: "number", description: "Index of the film moment that visually supports these words." },
          },
          required: ["text", "moment"],
          additionalProperties: false,
        },
      },
      title: { type: "string", description: "A short name for this video in the owner's review list. Max 50 characters." },
      caption: {
        type: "string",
        description:
          "The TikTok caption, max 90 characters: one question or disputed claim a viewer would answer in the comments. Not a summary of the text.",
      },
      hashtags: { type: "array", items: { type: "string" }, description: "3-5 tags, no # prefix." },
    },
    required: ["beats", "title", "caption", "hashtags"],
    additionalProperties: false,
  },
};

type Card = {
  beats: Array<{ text: string; moment: number }>;
  title: string;
  caption: string;
  hashtags: string[];
};

const BEAT_SEC = 4.5;
const BEAT_COUNT = 4;

/**
 * Makes the short version of a story that has just been written, and sends it
 * for review as a clip of its own. Returns the new clip's id.
 *
 * Throws on failure; the caller decides that a short that could not be made
 * must never cost the long video it came from.
 */
export async function makeTeaser(
  accountId: string,
  story: {
    /** The clip the long story is being edited as. */
    parentClipId: string;
    angle: string;
    narration: string[];
    film: { title: string; pageUrl: string; credit: string; when: string };
    moments: FilmMoment[];
    /** Already downloaded whole (a DVIDS asset), when there is one. */
    localFile?: string | null;
  },
): Promise<string> {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) throw new Error(`No account ${accountId}`);
  if (story.moments.length === 0) throw new Error("no surveyed moments to show");

  const response = await subscriptionMessagesCreate({
    model: MODELS.strategy,
    max_tokens: 2000,
    thinking: { type: "adaptive" },
    system:
      "You turn one true history story into four consecutive visual beats for a short vertical video. " +
      "There is no narration. Each beat must be readable before its shot ends. Begin with a concrete " +
      "tension, develop it with new information, and save the consequence for the last beat. " +
      "Match each beat to a visibly relevant film moment; do not reuse a moment unless the film has " +
      "fewer than four distinct usable shots. Plain facts, no hype, questions or emoji. " +
      "Never state a fact that is not in the story you were given.",
    tools: [TEASER_TOOL],
    tool_choice: { type: "tool", name: "write_story_card" },
    messages: [
      {
        role: "user",
        content: [
          `Account: @${account.handle} - ${account.niche}`,
          "",
          "THE STORY",
          story.angle,
          "",
          "AS NARRATED IN THE LONG VERSION",
          story.narration.join(" "),
          "",
          `FOOTAGE MOMENTS IN "${story.film.title}" (${story.film.when})`,
          ...story.moments.map((m, i) => `[moment ${i}] ${m.energy} - ${m.whatIsVisible}`),
        ].join("\n"),
      },
    ],
  });

  const block = response.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("the model returned no story card");
  const card = block.input as Card;
  const beats = card.beats;
  if (!Array.isArray(beats) || beats.length !== BEAT_COUNT) {
    throw new Error(`the short needs exactly ${BEAT_COUNT} story beats`);
  }
  for (const [i, beat] of beats.entries()) {
    const words = String(beat.text ?? "").trim().split(/\s+/).filter(Boolean);
    if (words.length < 4 || words.length > 9) throw new Error(`beat ${i + 1} needs 4-9 words`);
    if (!Number.isInteger(beat.moment) || !story.moments[beat.moment]) {
      throw new Error(`beat ${i + 1} refers to a missing film moment`);
    }
  }
  if (story.moments.length >= BEAT_COUNT && new Set(beats.map((b) => b.moment)).size < 3) {
    throw new Error("the short repeats the same film moment too often");
  }

  let tags = Array.isArray(card.hashtags) ? card.hashtags.slice(0, 5) : [];
  tags = tags.map((t) => String(t).replace(/^#+/, "").trim()).filter(Boolean);

  const clip = db
    .insert(clips)
    .values({
      accountId,
      sourceType: "dvids",
      sourceUrl: story.film.pageUrl,
      sourceTitle: story.film.title,
      sourceUploader: story.film.credit,
      status: "editing",
      hookText: (card.title || beats[0].text).slice(0, 70),
      caption: (card.caption ?? "").slice(0, 90),
      hashtags: JSON.stringify(tags),
      rationale: `Short version of ${story.parentClipId}: four paced story beats over matched archive shots.`,
    } as never)
    .returning()
    .get() as typeof clips.$inferSelect;

  try {
    noteProgress(clip.id, "Short version: cutting four archive shots to the four story beats");
    const source = story.localFile && fs.existsSync(story.localFile)
      ? path.resolve(story.localFile)
      : await resolveMediaUrl(story.film.pageUrl);
    if (!source) throw new Error(`could not resolve the film at ${story.film.pageUrl}`);

    const { bin, prefix } = splitCmd(env.ffmpeg);
    const sourceDuration = (await probe(source)).durationSec;
    const raw = path.join(rawDir, `${clip.id}-teaser.mp4`);
    const shotFiles: string[] = [];
    for (const [i, beat] of beats.entries()) {
      const selected = story.moments[beat.moment];
      const shot = path.join(rawDir, `${clip.id}-teaser-shot-${i}.mp4`);
      shotFiles.push(shot);
      const startSec = Math.max(0, Math.min(selected.atSec - 0.5, sourceDuration - BEAT_SEC));
      await run(bin, [
        ...prefix, "-y", "-v", "error", "-ss", startSec.toFixed(3),
        "-i", source, "-t", String(BEAT_SEC), "-vf", "fps=30,setsar=1",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", shot,
      ], { timeoutMs: 5 * 60_000 });
      if ((await probe(shot)).durationSec < BEAT_SEC - 0.5) {
        throw new Error(`film moment ${beat.moment} ends too early for beat ${i + 1}`);
      }
    }
    const concat = path.join(rawDir, `${clip.id}-teaser-concat.txt`);
    fs.writeFileSync(concat, shotFiles.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
    await run(bin, [...prefix, "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", concat,
      "-c", "copy", raw], { timeoutMs: 5 * 60_000 });
    if ((await probe(raw)).durationSec < BEAT_SEC * BEAT_COUNT - 1) {
      throw new Error("the four-shot montage is shorter than planned");
    }

    const spec = path.join(rawDir, `${clip.id}-teaser.json`);
    fs.writeFileSync(spec, JSON.stringify({ beats: beats.map((b) => b.text), beatSec: BEAT_SEC,
      handle: account.handle }), "utf8");
    const output = path.join(outDir, `${clip.id}.mp4`);
    const py = splitCmd(env.python);
    const { stdout } = await run(
      py.bin,
      [...py.prefix, path.join("src", "lib", "teaser_card.py"), "--clip", raw, "--spec", spec, "--out", output, "--ffmpeg", bin],
      { timeoutMs: 5 * 60_000 },
    );
    const result = JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? "{}") as { ok?: boolean; error?: string };
    if (!result.ok) throw new Error(result.error ?? "the story card did not render");

    const info = await probe(output);
    let thumb: string | null = null;
    try {
      thumb = await extractThumbnail(output, clip.id);
    } catch {
      thumb = null;
    }
    db.update(clips)
      .set({
        status: "ready",
        script: JSON.stringify(beats.map((b, i) => ({ text: b.text,
          intent: i === 0 ? "open" : i === beats.length - 1 ? "payoff" : "escalate" }))),
        rawPath: raw,
        outputPath: output,
        thumbnailPath: thumb,
        outputDurationSec: info.durationSec,
        sizeBytes: info.sizeBytes,
        error: null,
      })
      .where(eq(clips.id, clip.id))
      .run();
    noteProgress(clip.id, `Short version ready - ${Math.round(info.durationSec)}s. Waiting for your OK`);
    logEvent({
      accountId,
      level: "success",
      type: "teaser.ready",
      message: `Short version ready (${Math.round(info.durationSec)}s): ${card.title || beats[0].text}`,
      meta: { clipId: clip.id, parentClipId: story.parentClipId },
    });

    // Reviewed like every other video: nothing posts without the owner's OK.
    const fresh = db.select().from(clips).where(eq(clips.id, clip.id)).get();
    if (fresh) await sendForReview(fresh, output, info.durationSec);
    return clip.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.update(clips).set({ status: "failed", error: message }).where(eq(clips.id, clip.id)).run();
    throw err;
  }
}
