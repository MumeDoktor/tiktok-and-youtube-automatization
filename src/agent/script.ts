import { desc, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "@/db";
import { accounts, contentProfiles, posts } from "@/db/schema";
import { anthropic } from "@/lib/anthropic";
import { MODELS } from "@/lib/env";
import { normaliseLook, type EffectHit, type Look } from "@/lib/look";
import type { ScriptLine } from "@/lib/tts";
import { sourceWindowSec } from "@/lib/ae-editor";
import { latestAnalysis } from "./account-analysis";

/**
 * The length rule for the writer, sized to the owner's CLIP_MIN_SEC-CLIP_MAX_SEC.
 *
 * Aims at the middle of the window the edit needs going in: a narrator speaks
 * at about two and a half words a second including pauses.
 */
function narrationLength(): string {
  const { minSec, maxSec } = sourceWindowSec();
  const sec = Math.round((minSec + maxSec) / 2);
  const words = Math.round(sec * 2.4);
  return (
    `- ${Math.max(4, Math.round(sec / 4.5))}-${Math.max(5, Math.round(sec / 3.5))} lines and about ${words} words IN TOTAL. ` +
    `The narrator speaks at roughly two and a half words a second, so ${words} words plus pauses lands at about ${sec} seconds - ` +
    `the length the owner wants. Anything much longer is cut.`
  );
}

/**
 * Writes the narration for one video.
 *
 * This is the step the pipeline was missing. Everything downstream is timed
 * against the spoken result: shots change on line boundaries, captions land on
 * word boundaries, the punch-in hits the payoff. Without a script there is
 * nothing to cut to, which is why the old pipeline could only divide a single
 * take into equal slices.
 */

const WRITE_TOOL: Anthropic.Tool = {
  name: "write_script",
  description:
    "Write the spoken narration for one vertical video, plus the on-screen treatment it should use.",
  input_schema: {
    type: "object",
    properties: {
      lines: {
        type: "array",
        description:
          "The narration, one sentence per entry, in order. 10-13 entries, and 110 words across ALL of them put together. Each is spoken aloud by a synthetic narrator, so keep them short and declarative - long subordinate clauses read flat.",
        items: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description:
                "One spoken sentence, averaging 9 words and never over 14. Write numbers as a narrator would say them, and expand abbreviations the voice would otherwise spell out.",
            },
            intent: {
              type: "string",
              enum: ["open", "escalate", "turn", "payoff"],
              description:
                "open plants the question - only the first line. escalate raises the stakes or adds a stranger fact; it must never be there only to supply context. turn is where the story goes somewhere the viewer did not expect. payoff answers the question the opening planted and must be the LAST line, or second to last if one closing line genuinely lands better after it. Exactly one open and exactly one payoff.",
            },
          },
          required: ["text", "intent"],
          additionalProperties: false,
        },
      },
      hookText: {
        type: "string",
        description:
          "Burned across the upper third for the first two seconds, then it leaves. Max 60 characters. It must NOT restate the first spoken line - the viewer reads it and hears the narration at the same time, so saying the same thing twice wastes the only two seconds that decide whether they stay. Frame the stakes and let the narration deliver the fact.",
      },
      caption: {
        type: "string",
        description:
          "The TikTok caption. MAXIMUM 80 CHARACTERS. This account's biggest videos have captions of about 40 characters. The story is in the narration, not here.",
      },
      hashtags: {
        type: "array",
        items: { type: "string" },
        description: "3-5 tags, no # prefix.",
      },
      hits: {
        type: "array",
        description:
          "Visual effects fired on individual spoken words. AT MOST FOUR for the whole video, and none at all is a valid answer. Only fire on a word the story actually leans on - a detonation, an impact, a failure, the single word the payoff turns on. Firing on ordinary nouns is what makes a video look like a template with effects switched on. Never put two on the same line.",
        items: {
          type: "object",
          properties: {
            line: { type: "number", description: "Index of the narration line, counting from 0." },
            word: {
              type: "string",
              description:
                "The exact word from that line to fire on. One word, no punctuation.",
            },
            effect: {
              type: "string",
              enum: ["shake", "flash", "shockwave", "punch", "rumble", "burn", "glitch", "drop"],
              description:
                "shake is an impact or collision. flash is a detonation, gunfire or ignition. shockwave is a blast or pressure wave. punch is a hard zoom for a single decisive word or a revelation. rumble is a sustained tremor - engines, dread, something approaching. burn is fire or heat. glitch is malfunction, radiation, something going wrong. drop is sinking, falling or loss. Match the effect to what the word means; a mismatch is worse than no effect.",
            },
            intensity: {
              type: "number",
              description: "0.3 is a suggestion, 1 is full force. Most should sit near 0.6.",
            },
          },
          required: ["line", "word", "effect", "intensity"],
          additionalProperties: false,
        },
      },
      openLoop: {
        type: "string",
        description:
          "The question the opening plants in the viewer's head, written in their words, e.g. 'why couldn't the plane turn?'. The payoff must answer exactly this question. If you cannot state the question, the video has no reason to be watched to the end.",
      },
      musicMood: {
        type: "string",
        description:
          "One or two words for the bed under the narration, e.g. 'tense', 'elegiac', 'driving'. Used to pick from the owner's licensed library.",
      },
      look: {
        type: "object",
        description:
          "The on-screen treatment for THIS video. Vary it by story - identical treatment on every clip is what makes video look machine-made.",
        properties: {
          captions: {
            type: "string",
            enum: ["kinetic", "block", "none"],
            description:
              "kinetic is word-by-word in sync with the voice and suits nearly everything. block shows a full line at a time. none is for footage that carries itself.",
          },
          hookExit: {
            type: "number",
            description: "Seconds the hook holds before leaving. 1.5-3.",
          },
          accent: {
            type: "string",
            description:
              "Hex colour for emphasised words, e.g. '#E0A526'. Pick something that suits the footage.",
          },
          grade: {
            type: "string",
            enum: ["archive", "cold", "warm", "none"],
            description:
              "archive warms and lifts old film. cold suits jets and steel. warm suits people. none leaves the footage alone.",
          },
          chrome: {
            type: "array",
            items: { type: "string", enum: ["grain", "scanlines", "timecode", "stamp"] },
            description:
              "Only what this story earns. Mid-century film can carry grain and a timecode burn; modern footage usually should not.",
          },
          stamps: {
            type: "array",
            description:
              "Location and date cards, e.g. 'USS ENTERPRISE - 1962'. Only if 'stamp' is in chrome.",
            items: {
              type: "object",
              properties: {
                atSec: { type: "number" },
                text: { type: "string" },
              },
              required: ["atSec", "text"],
              additionalProperties: false,
            },
          },
          motion: {
            type: "object",
            description:
              "The ambient motion layer - continuously-running graphics that make footage feel graded and produced. All default to on; turn one off only with a reason tied to THIS story.",
            properties: {
              lightLeak: {
                type: "boolean",
                description:
                  "Warm analogue light drifting across the frame twice per video. Suits archive film; modern digital footage can take it too.",
              },
              vignette: {
                type: "boolean",
                description: "Cinematic darkened corners pulling the eye centre-ward.",
              },
              speedRamp: {
                type: "boolean",
                description:
                  "Violent moments linger through their middle third, then release. On when the story has a launch, blast or impact; off for quiet stories.",
              },
              lowerThird: {
                type: "object",
                description:
                  "A documentary name-card that slides in once, early. The text must come from the source material given to you - the film's title or the location - never invented.",
                properties: {
                  text: { type: "string", description: "Max 60 characters." },
                  sub: { type: "string", description: "Optional second line, e.g. a year or place." },
                  atSec: { type: "number", description: "When it appears. 3-6 is usual, after the hook leaves." },
                  holdSec: { type: "number", description: "How long it stays. 2-4." },
                },
                required: ["text", "atSec", "holdSec"],
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
        },
        required: ["captions", "hookExit", "accent", "grade", "chrome"],
        additionalProperties: false,
      },
    },
    required: ["lines", "hookText", "caption", "hashtags", "hits", "openLoop", "musicMood", "look"],
    additionalProperties: false,
  },
};

export type Script = {
  lines: ScriptLine[];
  hookText: string;
  /** The question the opening plants and the payoff answers. */
  openLoop: string;
  /** Effects tied to specific words, resolved to timestamps after speaking. */
  hits: EffectHit[];
  caption: string;
  hashtags: string[];
  musicMood: string;
  look: Look;
};

/**
 * Writes the narration for an agreed angle, over footage that has already been
 * described.
 *
 * `footage` is what the vision step actually saw, so the narration can refer to
 * what is on screen instead of to what the archive catalogue claimed.
 */
export async function writeScript(
  accountId: string,
  angle: string,
  footage: { title: string; description: string; year?: string },
  /**
   * What the owner already agreed to in chat, when there was a conversation.
   *
   * Without this the script is written from scratch against the footage and
   * quietly replaces whatever the agent promised, so the owner approves one
   * hook and is handed another.
   */
  agreed?: { hookText?: string | null; caption?: string | null },
): Promise<Script> {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) throw new Error(`No account ${accountId}`);

  const profile = db
    .select()
    .from(contentProfiles)
    .where(eq(contentProfiles.accountId, accountId))
    .get();

  // The account's own short captions, as the length example. Telling a model
  // "be brief" works far less well than showing it what brief looked like here.
  const winners = db
    .select({ caption: posts.caption })
    .from(posts)
    .where(eq(posts.accountId, accountId))
    .orderBy(desc(posts.publishedAt))
    .limit(60)
    .all()
    .map((p) => p.caption)
    .filter((c) => c && c.length > 0 && c.length <= 70)
    .slice(0, 8);

  const analysis = latestAnalysis(accountId);
  let read = "";
  if (analysis?.rawAnalysis) {
    try {
      const parsed = JSON.parse(analysis.rawAnalysis) as {
        read?: { summary?: string; whatWorks?: string[] };
      };
      const lines: string[] = [];
      if (parsed.read?.summary) lines.push(parsed.read.summary);
      if (parsed.read?.whatWorks?.length) {
        lines.push("", "What works:");
        for (const w of parsed.read.whatWorks) lines.push(`- ${w}`);
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
      "You write spoken narration for short vertical video. Your only real job is to make someone keep " +
      "watching, and they can leave at any second. " +
      "Nothing else you do matters if they leave at three seconds. " +
      "The way to hold them is to plant a question and refuse to answer it until the end. Withhold the " +
      "outcome. A video that states its conclusion in the first line has no reason to be watched. " +
      "The narration is read aloud by a synthetic voice, so write for the ear: short declarative sentences, " +
      "concrete nouns, no stacked subordinate clauses, no rhetorical questions. " +
      "Write what a person would say out loud, not what a caption would say. " +
      "You are given a description of the footage that will actually be on screen - never describe something " +
      "that is not in it, and never claim a fact you were not given. " +
      "Every video you dress must not look like the last one: the treatment is a choice per story, not a template.",
    tools: [WRITE_TOOL],
    tool_choice: { type: "tool", name: "write_script" },
    messages: [
      {
        role: "user",
        content: [
          `Account: @${account.handle} - ${account.niche}`,
          profile?.toneOfVoice ? `Tone: ${profile.toneOfVoice}` : "",
          "",
          read ? `THE STANDING READ OF THIS ACCOUNT\n${read}\n` : "",
          "THE ANGLE AGREED WITH THE OWNER",
          angle,
          "",
          "THE FOOTAGE THAT WILL BE ON SCREEN",
          `${footage.title}${footage.year ? ` (${footage.year})` : ""}`,
          footage.description,
          "",
          winners.length
            ? `CAPTIONS THAT WORKED ON THIS ACCOUNT - match this length, not longer:\n${winners
                .map((c) => `- ${c}`)
                .join("\n")}`
            : "",
          "",
          agreed?.hookText
            ? `ALREADY AGREED WITH THE OWNER - keep faith with this\nDirection: ${agreed.hookText}` +
              (agreed.caption ? `\nCaption they expect: ${agreed.caption}` : "")
            : "",
          "",
          "Write the narration. Requirements:",
          narrationLength(),
          "",
          "RETENTION. This is the part that decides whether the video works:",
          "- The first line plants a question and does NOT answer it. State the openLoop field first, then write an opening that makes the viewer need that answer.",
          "- Never give away the outcome early. If the first line already contains the ending, there is nothing left to stay for.",
          "- The strangest concrete detail you have goes in the first three lines. Do not save it for the middle.",
          "- Every line must add a new fact or raise the stakes. If a line could be deleted without the viewer losing anything, delete it.",
          "- A date, a place name or an operation name is NEVER a line by itself. Weave it into a line that also moves the story.",
          "- The payoff must be INFORMATION - the answer to the question you planted. Never a rhetorical inversion, never wordplay, never a summary of what was already said.",
          "",
          "This is what a failed script looks like, from this account:",
          '  hook  "They anchored their own fleet under an atomic bomb."',
          '  line1 "The Navy anchored its own warships in a lagoon and dropped an atomic bomb on them."',
          "  ...then fifteen seconds of date, operation name and men watching through binoculars...",
          '  payoff "The Navy set out to test a bomb, and the bomb tested the Navy."',
          "It failed for three reasons: the hook and the first line said the same thing so the premise was spent in two seconds, the middle was context rather than escalation, and the payoff was wordplay instead of an answer. The one genuinely interesting fact - that the ships which SURVIVED were the real problem - arrived at thirty seconds, long after everyone had gone. That fact should have been the question planted at the start.",
          "",
          "- Never state a fact you were not given. If you need a detail the footage description does not supply, write around it.",
          "- The caption is a label, not the story. Keep it under 80 characters.",
          agreed?.hookText
            ? "- The owner agreed to the direction above. Stay on that story. Sharpen the wording if the footage supports something better, but do not switch to a different subject."
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });

  const block = response.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error("The agent returned no script.");
  }

  const raw = block.input as Script & { look: unknown };
  let lines = (raw.lines ?? [])
    .filter((l) => l && typeof l.text === "string" && l.text.trim().length > 0)
    .slice(0, 18);
  if (lines.length === 0) throw new Error("The agent returned an empty script.");

  // Everything after the payoff is dilution. One closing line can land well;
  // a run of them spends the answer and then keeps talking, which is how a
  // video that finally earned its ending throws the ending away.
  const payoff = lines.findIndex((l) => l.intent === "payoff");
  if (payoff >= 0 && payoff < lines.length - 2) {
    lines = [...lines.slice(0, payoff + 1), lines[lines.length - 1]];
  }

  return {
    lines,
    hookText: (raw.hookText ?? "").slice(0, 70),
    openLoop: typeof raw.openLoop === "string" ? raw.openLoop : "",
    // Capped in code as well as in the prompt. Effects earn their weight by
    // being rare, and a model asked for "at most four" will occasionally
    // return nine.
    hits: Array.isArray(raw.hits)
      ? raw.hits
          .filter(
            (h): h is EffectHit =>
              Boolean(h) && typeof h.word === "string" && Number.isFinite(Number(h.line)),
          )
          .slice(0, 4)
          .map((h) => ({
            ...h,
            line: Number(h.line),
            intensity: Math.max(0.2, Math.min(1, Number(h.intensity) || 0.6)),
          }))
      : [],
    // Enforced rather than requested: the model is asked for 80 and the old
    // pipeline routinely produced 500-character essays in this field.
    caption: (raw.caption ?? "").slice(0, 80),
    hashtags: Array.isArray(raw.hashtags) ? raw.hashtags.slice(0, 5) : [],
    musicMood: typeof raw.musicMood === "string" ? raw.musicMood : "",
    look: normaliseLook(raw.look),
  };
}
