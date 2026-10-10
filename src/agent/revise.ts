import fs from "node:fs";
import path from "node:path";
import { and, desc, eq, like } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";

import { db } from "@/db";
import { agentMemory, clips, jobs } from "@/db/schema";
import { aeRunDir } from "@/lib/ae-editor";
import { subscriptionMessagesCreate } from "@/lib/claude-subscription";
import { MODELS } from "@/lib/env";
import { awaitReasonFor, telegramText } from "@/lib/telegram";
import { editInAe, type AeEditPayload } from "./ae-edit";
import { logEvent, noteProgress } from "./events";

/**
 * A rejected video, fixed from the owner's own words.
 *
 * The owner says what is wrong ("at 0:12 the text is too small", "the music is
 * too loud"). Claude reads that against the built edit - which line is said
 * when, what is on screen over it - and turns it into the After Effects
 * editor's notes. The editor then recomposes only the moments the notes touch
 * and keeps everything else exactly as it was; the new export comes back to
 * the phone for review like the first one.
 */

export type RevisePayload = { clipId: string; feedback: string };

type EditorNote = { spanIndex?: number; spans?: number[]; note: string };

type Plan = {
  duration?: number;
  segments?: { spanIndex: number; outStart: number; outEnd: number }[];
  captions?: { text: string; start: number; end: number }[];
  treatments?: { spanIndex: number; start: number; duration: number; elements?: { type: string; content?: string; assetId?: string }[] }[];
};

const REVISE_TOOL: Anthropic.Tool = {
  name: "revise_edit",
  description: "Turn the owner's review of a finished edit into instructions for the editor.",
  input_schema: {
    type: "object",
    properties: {
      understood: {
        type: "string",
        description:
          "One or two plain sentences to the owner saying what will change - so they can tell they were understood.",
      },
      spanNotes: {
        type: "array",
        description:
          "Notes on specific moments. Each names the span(s) it is about and says, in the owner's spirit, what to change there.",
        items: {
          type: "object",
          properties: {
            spans: { type: "array", items: { type: "integer" } },
            note: { type: "string" },
          },
          required: ["spans", "note"],
        },
      },
      wholeNote: {
        type: ["string", "null"],
        description: "A note about the edit as a whole (e.g. text too busy everywhere), or null.",
      },
      dropSpans: {
        type: "array",
        items: { type: "integer" },
        description: "Lines to cut out completely. Only when cutting is offered below; otherwise [].",
      },
      musicDb: {
        type: ["number", "null"],
        description: "New music level in dB (currently given below), only if the owner commented on the music.",
      },
      appetite: {
        type: ["number", "null"],
        description:
          "How much the editor adds, relative to 1.0 (current value given below). Lower for 'too many effects', higher for 'too plain'. null to keep it.",
      },
      cannotFix: {
        type: ["string", "null"],
        description: "Anything in the feedback a re-edit cannot change, said plainly, or null.",
      },
    },
    required: ["understood", "spanNotes", "wholeNote", "dropSpans", "musicDb", "appetite", "cannotFix"],
  },
};

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** The edit as the owner saw it: each line, when it plays, and what is on screen over it. */
function describeEdit(plan: Plan): string {
  const lines: string[] = [];
  for (const seg of plan.segments ?? []) {
    const words = (plan.captions ?? [])
      .filter((c) => c.start >= seg.outStart - 0.01 && c.start < seg.outEnd)
      .map((c) => c.text)
      .join(" ");
    const over = (plan.treatments ?? [])
      .filter((t) => t.spanIndex === seg.spanIndex)
      .flatMap((t) => t.elements ?? [])
      .map((e) => (e.content ? `${e.type} "${e.content}"` : e.assetId ? `picture ${e.assetId}` : e.type))
      .join(", ");
    lines.push(
      `span ${seg.spanIndex}  ${fmt(seg.outStart)}-${fmt(seg.outEnd)}  "${words}"` + (over ? `\n    on screen: ${over}` : ""),
    );
  }
  return lines.join("\n");
}

/** The payload the clip was last edited with. */
function lastEditPayload(clipId: string): AeEditPayload | null {
  const row = db
    .select()
    .from(jobs)
    .where(and(eq(jobs.type, "edit_ae"), like(jobs.payload, `%"clipId":"${clipId}"%`)))
    .orderBy(desc(jobs.createdAt))
    .get();
  return row ? (JSON.parse(row.payload) as AeEditPayload) : null;
}

/**
 * What the owner's feedback means for this edit: the notes and settings for the
 * rebuild. Reads the run directory and asks Claude; changes nothing.
 */
export async function draftRevision(clipId: string, feedback: string) {
  const clip = db.select().from(clips).where(eq(clips.id, clipId)).get();
  if (!clip) throw new Error(`No clip ${clipId}`);
  const hook = clip.hookText || clip.sourceTitle || "the video";

  const runDir = aeRunDir(clip.id);
  const planPath = path.join(runDir, "plan.json");
  const previous = lastEditPayload(clip.id);
  if (!previous || !fs.existsSync(planPath)) return { clip, hook, notBuilt: true as const };
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as Plan;
  const notesPath = path.join(runDir, "notes.json");
  const priorNotes: EditorNote[] = fs.existsSync(notesPath)
    ? (JSON.parse(fs.readFileSync(notesPath, "utf8")) as EditorNote[])
    : [];
  const musicDb = previous.musicDb ?? -16;
  const appetite = previous.appetite ?? 1;

  const response = await subscriptionMessagesCreate({
    model: MODELS.strategy,
    max_tokens: 3000,
    system:
      "You are the assistant editor on a short vertical video. The owner watched the finished cut on " +
      "their phone and rejected it, saying what is wrong in their own words. Your job is to turn that " +
      "into precise notes for the motion editor, who will recompose ONLY the moments the notes name and " +
      "keep everything else identical. Times the owner mentions are times in the finished video - match " +
      "them to spans by the timings given, allowing a second or two of slack. Keep the owner's intent; do " +
      "not add requests of your own. If the owner mentions no time, find the moment from what they " +
      "describe; if it is about the whole video, use wholeNote.\n\n" +
      "A re-edit CAN change: the motion graphics, on-screen text and pictures over any moment; how busy " +
      "the whole edit is (appetite); the music level" +
      (previous.keepAll ? "; and cut whole lines out (dropSpans)." : ".") +
      "\nIt CANNOT change: the narration's voice or words, the subtitle style, the underlying footage, or " +
      "the story itself. Say so in cannotFix when the feedback asks for those.",
    tools: [REVISE_TOOL],
    tool_choice: { type: "tool", name: "revise_edit" },
    messages: [
      {
        role: "user",
        content: [
          `Video: ${hook} (${fmt(plan.duration ?? 0)} long)`,
          `Music: ${previous.musicPath ? `${musicDb}dB under the voice` : "none"} · appetite ${appetite}`,
          previous.keepAll ? "Cutting whole lines is possible." : "Cutting lines is not possible for this video.",
          "",
          "THE EDIT, line by line (span index, time in the video, the words, what is on screen):",
          describeEdit(plan),
          priorNotes.length
            ? `\nNOTES ALREADY GIVEN IN EARLIER REVIEWS (already applied):\n${priorNotes.map((n) => `- ${n.spans ?? n.spanIndex ?? "whole"}: ${n.note}`).join("\n")}`
            : "",
          "",
          "THE OWNER'S FEEDBACK:",
          feedback,
        ]
          .filter((l) => l !== "")
          .join("\n"),
      },
    ],
  });

  const block = response.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("Claude did not return revision notes");
  const r = block.input as {
    understood: string;
    spanNotes: { spans: number[]; note: string }[];
    wholeNote: string | null;
    dropSpans: number[];
    musicDb: number | null;
    appetite: number | null;
    cannotFix: string | null;
  };

  const known = new Set((plan.segments ?? []).map((s) => s.spanIndex));
  const fresh: EditorNote[] = [
    ...r.spanNotes
      .map((n) => ({ spans: n.spans.filter((s) => known.has(s)), note: n.note }))
      .filter((n) => n.spans.length > 0)
      .map((n) => (n.spans.length === 1 ? { spanIndex: n.spans[0], note: n.note } : n)),
    ...(r.wholeNote ? [{ note: r.wholeNote }] : []),
  ];
  // A newer note on the same moment replaces the older one; the rest stand.
  const key = (n: EditorNote) => JSON.stringify(n.spans ?? n.spanIndex ?? "whole");
  const freshKeys = new Set(fresh.map(key));
  const notes = [...priorNotes.filter((n) => !freshKeys.has(key(n))), ...fresh];

  const next: AeEditPayload = {
    ...previous,
    musicDb: r.musicDb ?? previous.musicDb,
    appetite: r.appetite ?? previous.appetite,
    dropSpans: previous.keepAll
      ? [...new Set([...(previous.dropSpans ?? []), ...r.dropSpans.filter((s) => known.has(s))])]
      : previous.dropSpans,
  };

  const changes = fresh.length + (next.musicDb !== previous.musicDb ? 1 : 0)
    + (next.appetite !== previous.appetite ? 1 : 0)
    + ((next.dropSpans?.length ?? 0) - (previous.dropSpans?.length ?? 0));
  return { clip, hook, notBuilt: false as const, r, notes, next, changes, runDir, notesPath };
}

export async function reviseInAe(accountId: string, payload: RevisePayload) {
  const { clipId, feedback } = payload;
  const d = await draftRevision(clipId, feedback);
  const { clip, hook } = d;
  if (d.notBuilt) {
    telegramText(`I can't re-edit "${hook}" - it wasn't built in After Effects. Tap 🆕 to make a new video instead.`);
    return;
  }
  const { r, notes, next, changes, runDir, notesPath } = d;
  noteProgress(clip.id, `Owner's review: ${feedback}`);

  if (changes === 0) {
    // Still listening: the owner's next message adds to what they said.
    awaitReasonFor(clipId, feedback);
    telegramText(
      `I couldn't turn that into a change to the edit${r.cannotFix ? `: ${r.cannotFix}` : "."}\n\n` +
        "Reply with more detail (a time like 0:12 helps), or tap 🆕 to make a new video.",
    );
    return;
  }

  fs.writeFileSync(notesPath, JSON.stringify(notes, null, 1), "utf8");
  // The editor refuses to rebuild an edit it already built; this one is meant to be.
  const result = path.join(runDir, "result.json");
  if (fs.existsSync(result)) fs.renameSync(result, path.join(runDir, `result.${Date.now()}.json`));
  db.update(clips).set({ status: "editing", error: null }).where(eq(clips.id, clip.id)).run();

  logEvent({ accountId, type: "clip.revising", message: `Re-editing "${hook}": ${r.understood}` });
  telegramText(
    `🔁 Re-editing "${hook}"\n${r.understood}` +
      (r.cannotFix ? `\n\nCan't change: ${r.cannotFix}` : "") +
      "\n\nThe new version will arrive here for review.",
  );

  await editInAe(accountId, next);
}

/**
 * The owner rejected a video outright and wants a different one. Their reason
 * is kept as a standing lesson, so the next decision does not repeat it.
 */
export function rememberRejection(accountId: string, clipId: string, feedback: string) {
  const clip = db.select().from(clips).where(eq(clips.id, clipId)).get();
  const hook = clip?.hookText || clip?.sourceTitle || clipId;
  db.insert(agentMemory)
    .values({
      accountId,
      kind: "learning",
      source: "manual",
      content: `Owner rejected "${hook.slice(0, 120)}": ${feedback.slice(0, 500)}`,
    })
    .run();
}

/** The owner's recent rejections, for the decision of what to make next. */
export function recentRejections(accountId: string, limit = 10): string[] {
  return db
    .select({ content: agentMemory.content })
    .from(agentMemory)
    .where(
      and(
        eq(agentMemory.accountId, accountId),
        eq(agentMemory.active, true),
        like(agentMemory.content, "Owner rejected %"),
      ),
    )
    .orderBy(desc(agentMemory.createdAt))
    .limit(limit)
    .all()
    .map((m) => m.content);
}
