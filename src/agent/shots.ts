import type Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "@/lib/anthropic";
import { MODELS } from "@/lib/env";
import type { Move, Transition } from "@/lib/look";
import { clearFrames, sampleRemoteFrames } from "@/lib/media";
import type { VoiceLine } from "@/lib/tts";
import { logEvent } from "./events";

/**
 * Turning a film into a shot list.
 *
 * Two steps, because they need different things. The survey has to *see* the
 * footage, so it is expensive and runs once. The assignment only has to match
 * descriptions against narration, so it is text-only and cheap.
 *
 * The old pipeline picked one moment and sliced it into equal parts, which is
 * why every clip read as a single locked-off take. A shot list of distinct
 * moments, each cut to the line it illustrates, is the actual fix.
 */

/* ------------------------------------------------------------------ */
/* 1. Survey - the only step that looks at the footage                 */
/* ------------------------------------------------------------------ */

const SURVEY_TOOL: Anthropic.Tool = {
  name: "survey_film",
  description:
    "Report what is actually visible in this film and list the distinct moments worth cutting.",
  input_schema: {
    type: "object",
    properties: {
      found: {
        type: "boolean",
        description:
          "False when nothing in these frames suits the story. Declining is correct when the film turns out to be the wrong subject.",
      },
      reason: {
        type: "string",
        description: "Why this film does or does not carry the story, grounded in what you can see.",
      },
      summary: {
        type: "string",
        description:
          "What this film actually contains, in 2-4 sentences. This is handed to the writer as the description of what will be on screen, so it must be concrete and true to the frames - it is the only thing standing between the narration and invented detail.",
      },
      moments: {
        type: "array",
        description:
          "The distinct usable moments, in time order. Aim for 10-20. Distinct means a different shot, not a different second of the same shot - two frames of the same locked-off view are one moment.",
        items: {
          type: "object",
          properties: {
            atSec: {
              type: "number",
              description: "A sampled timestamp where this shot is visible.",
            },
            whatIsVisible: {
              type: "string",
              description:
                "One concrete line describing this shot. Name what is in the frame - subject, action, framing.",
            },
            energy: {
              type: "string",
              enum: ["still", "moving", "violent"],
              description:
                "still is a locked-off or slow shot, moving is normal action, violent is a launch, blast, impact or fast pass.",
            },
          },
          required: ["atSec", "whatIsVisible", "energy"],
          additionalProperties: false,
        },
      },
    },
    required: ["found", "reason", "summary", "moments"],
    additionalProperties: false,
  },
};

export type FilmMoment = {
  atSec: number;
  whatIsVisible: string;
  energy: "still" | "moving" | "violent";
};

export type Survey = {
  found: boolean;
  reason: string;
  summary: string;
  moments: FilmMoment[];
};

/**
 * Looks at the film and reports what is in it.
 *
 * Everything upstream chooses from text: a catalogue description says "life
 * aboard the USS Enterprise", which is equally true of a carrier launch and of
 * the ship's barbershop. This is the step that tells them apart, and the only
 * place the agent sees the footage rather than reading about it.
 */
export async function surveyFilm(
  accountId: string,
  pageUrl: string,
  filmDurationSec: number,
  angle: string,
): Promise<Survey> {
  // Deliberately generous. The old value of 18 was sized for picking a single
  // moment; a shot list needs a pool to choose from, and sampling is cheap
  // because it range-reads rather than downloading.
  const frames = await sampleRemoteFrames(pageUrl, {
    durationSec: filmDurationSec,
    maxFrames: 40,
  });

  if (frames.length === 0) {
    return {
      found: false,
      reason:
        "Could not sample any frames from this film, so there is no way to see what it contains.",
      summary: "",
      moments: [],
    };
  }

  logEvent({
    accountId,
    type: "shots.sampled",
    message: `Sampled ${frames.length} frames across ${Math.round(filmDurationSec)}s`,
  });

  // Each frame is labelled with its timestamp immediately before the image, so
  // the model can tie what it sees to a number it can return.
  const content: Anthropic.ContentBlockParam[] = [
    {
      type: "text",
      text: [
        `STORY TO TELL: ${angle}`,
        `FILM LENGTH: ${Math.round(filmDurationSec)} seconds`,
        "",
        "Below are frames sampled across the film, each labelled with its timestamp.",
        "Report what the film contains and list the distinct moments worth cutting.",
      ].join("\n"),
    },
  ];

  for (const frame of frames) {
    content.push({ type: "text", text: `[${frame.atSec}s]` });
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: frame.base64 },
    });
  }

  content.push({
    type: "text",
    text: [
      "",
      "Rules:",
      "- Judge only what you can see. Do not assume footage exists between samples.",
      "- Reject title cards, credits, talking-head interviews and static diagrams.",
      "- Prefer motion and action: aircraft, ships, crews working, machinery running.",
      "- Two frames showing the same unchanged view are ONE moment, not two.",
      "- If none of these frames suit the story, decline. A mismatch is worse than nothing.",
    ].join("\n"),
  });

  try {
    const response = await anthropic().messages.create({
      model: MODELS.strategy,
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      system:
        "You select footage for short vertical video by looking at sampled frames. " +
        "You can see the images. Describe what is actually in the frames you choose - " +
        "a claim you cannot ground in a visible detail is a guess, and guessing is what " +
        "this step exists to remove.",
      tools: [SURVEY_TOOL],
      tool_choice: { type: "tool", name: "survey_film" },
      messages: [{ role: "user", content }],
    });

    const block = response.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") {
      return { found: false, reason: "The model returned no decision.", summary: "", moments: [] };
    }

    const survey = block.input as Survey;
    const moments = (survey.moments ?? [])
      .filter((m) => Number.isFinite(Number(m.atSec)))
      .map((m) => ({ ...m, atSec: Math.max(0, Number(m.atSec)) }))
      .sort((a, b) => a.atSec - b.atSec);

    return { ...survey, moments };
  } finally {
    // The stills are large and single-use.
    clearFrames(pageUrl);
  }
}

/* ------------------------------------------------------------------ */
/* 2. Assignment - matching shots to what is being said                */
/* ------------------------------------------------------------------ */

const ASSIGN_TOOL: Anthropic.Tool = {
  name: "assign_shots",
  description: "Choose which footage moment plays under each line of narration.",
  input_schema: {
    type: "object",
    properties: {
      assignments: {
        type: "array",
        description: "One entry per narration line, in order. Every line must get one.",
        items: {
          type: "object",
          properties: {
            line: { type: "number", description: "The narration line index." },
            moments: {
              type: "array",
              description:
                "One or two moment indices to play under this line. Use two when the line is long enough that a single shot would sit still, or when the line has two halves worth showing.",
              items: { type: "number" },
            },
            move: {
              type: "string",
              enum: ["push", "pull", "driftL", "driftR", "hold", "punch"],
              description:
                "The camera move over this line. push tightens, pull widens, driftL and driftR slide across, hold is locked off, punch is a hard snap in - reserve punch for the payoff.",
            },
            transition: {
              type: "string",
              enum: [
                "cut",
                "dissolve",
                "glide",
                "whipL",
                "whipR",
                "zoomBlur",
                "flash",
                "dipToBlack",
              ],
              description:
                "How this shot arrives over the previous one. glide and dissolve are smooth and suit most of a story. whipL and whipR are fast swipes for momentum. zoomBlur suits an impact or a reveal. flash suits archive film. dipToBlack is for where the story takes a breath. cut is instant - correct in a fast passage, but a run of them is monotonous. VARY THEM: never use the same transition more than twice running.",
            },
          },
          required: ["line", "moments", "move", "transition"],
          additionalProperties: false,
        },
      },
    },
    required: ["assignments"],
    additionalProperties: false,
  },
};

export type Shot = {
  /** Where in the source film this shot is taken from. */
  atSec: number;
  /** Where it sits in the finished video. */
  startMs: number;
  endMs: number;
  move: Move;
  /** How this shot arrives over the one before it. */
  transition: Transition;
  transitionMs: number;
  whatIsVisible: string;
};

type Assignment = {
  line: number;
  moments: number[];
  move: Move;
  transition: Transition;
};

/**
 * How long each transition runs.
 *
 * A swipe has to be fast or it reads as a slide; a dissolve has to breathe or
 * it reads as a glitch. These are the lengths that make each one look like
 * what it is meant to be.
 */
const TRANSITION_MS: Record<Transition, number> = {
  cut: 0,
  dissolve: 420,
  glide: 520,
  whipL: 360,
  whipR: 360,
  zoomBlur: 440,
  flash: 200,
  dipToBlack: 440,
};

/**
 * How much a line's picture is subdivided, by intent.
 *
 * 1 means one shot per line. Above 1 the line may take two quicker shots -
 * escalation feels faster because it *is* faster. Below 1 the line holds one
 * picture no matter how long it runs - the turn and the payoff need stillness
 * to register. This replaces the old flat "split anything over five seconds",
 * which gave every video the same even pulse regardless of what was happening.
 */
const PACING: Record<string, number> = {
  open: 1,
  escalate: 1.6,
  turn: 0.8,
  payoff: 0.8,
};

/**
 * Builds the shot list by matching surveyed moments to spoken lines.
 *
 * Text only - the moments were already described by the step that could see
 * them, so paying for the images twice buys nothing.
 *
 * Shot boundaries come from the narration timings, which is what makes the cut
 * land with the sentence rather than on a timer.
 */
export async function assignShots(
  script: { text: string; intent: string }[],
  lines: VoiceLine[],
  moments: FilmMoment[],
): Promise<Shot[]> {
  if (moments.length === 0) return [];

  const response = await anthropic().messages.create({
    model: MODELS.strategy,
    max_tokens: 3000,
    thinking: { type: "adaptive" },
    system:
      "You are cutting a short documentary. You are given narration lines with their exact " +
      "timings, and a list of footage moments with descriptions. Decide what is on screen " +
      "under each line. Match meaning where you can - when a line names a thing that appears " +
      "in a moment, use that moment. Vary the camera move between consecutive shots; the same " +
      "move repeated is what makes an edit look automated. Never leave a line without footage.",
    tools: [ASSIGN_TOOL],
    tool_choice: { type: "tool", name: "assign_shots" },
    messages: [
      {
        role: "user",
        content: [
          "NARRATION",
          ...lines.map(
            (l, i) =>
              `[line ${i}] ${((l.endMs - l.startMs) / 1000).toFixed(1)}s (${script[i]?.intent ?? "detail"}) - ${l.text}`,
          ),
          "",
          "FOOTAGE MOMENTS",
          ...moments.map((m, i) => `[moment ${i}] ${m.energy} - ${m.whatIsVisible}`),
          "",
          "Assign footage to every line. A moment may be reused if the film is short on material, but never twice in a row.",
        ].join("\n"),
      },
    ],
  });

  const block = response.content.find((b) => b.type === "tool_use");
  const assignments: Assignment[] =
    block && block.type === "tool_use"
      ? ((block.input as { assignments?: Assignment[] }).assignments ?? [])
      : [];

  const byLine = new Map<number, Assignment>();
  for (const a of assignments) byLine.set(Number(a.line), a);

  const shots: Shot[] = [];

  lines.forEach((line, i) => {
    const assignment = byLine.get(i);
    // Falling back to round-robin keeps a render alive when the model skips a
    // line; a missing shot would otherwise leave a hole in the video.
    const picked = (assignment?.moments ?? [])
      .map((n) => moments[Number(n)])
      .filter((m): m is FilmMoment => Boolean(m));
    const chosen = picked.length > 0 ? picked : [moments[i % moments.length]];

    const span = Math.max(300, line.endMs - line.startMs);
    // Pacing follows the story's shape, not a metronome. Escalations cut
    // faster - more pictures per sentence - because rising tension reads
    // through cutting rate before it reads through words. A turn or payoff
    // gets one held picture so the moment lands instead of flashing past.
    const rate = PACING[line.intent as keyof typeof PACING] ?? 1;
    // Long lines split only when the pacing wants them to; a payoff stays
    // whole even when it runs long.
    const count =
      (rate >= 1 && span / rate > 4200 && chosen.length > 1) ||
      (rate > 1 && chosen.length > 1)
        ? 2
        : 1;
    const each = span / count;

    for (let k = 0; k < count; k++) {
      const moment = chosen[k % chosen.length];
      shots.push({
        atSec: moment.atSec,
        startMs: line.startMs + k * each,
        endMs: line.startMs + (k + 1) * each,
        move: k === 0 ? (assignment?.move ?? "push") : alternate(assignment?.move ?? "push"),
        // A second shot inside one line is a jump within the same thought, so
        // it cuts rather than blends.
        transition: k === 0 ? (assignment?.transition ?? "glide") : "cut",
        transitionMs: 0,
        whatIsVisible: moment.whatIsVisible,
      });
    }
  });

  return timeTransitions(varyTransitions(dedupeAdjacent(spreadAcrossFilm(shots, moments))));
}

/**
 * Keeps consecutive shots visually different at the source.
 *
 * "Distinct moment" in the survey does not guarantee "distinct picture" in
 * the edit: two moments a second apart in a slow pan are the same frame, and
 * a cut between them reads as a stutter, not a cut. Every adjacent pair is
 * pushed to at least MIN_SOURCE_GAP apart, swapping in a moment the edit has
 * not used yet when there is one - which also spreads coverage across more
 * of the film instead of clustering on the first few finds.
 */
function spreadAcrossFilm(shots: Shot[], moments: FilmMoment[]): Shot[] {
  const MIN_SOURCE_GAP = 3;
  const used = new Set<number>();

  const nearestFree = (wantAt: number): FilmMoment | null => {
    let best: FilmMoment | null = null;
    let bestScore = -Infinity;
    for (const m of moments) {
      if (used.has(m.atSec)) continue;
      // Prefer close to what was asked for, but break ties toward moments
      // nothing else is using - that is what spreads coverage.
      const distance = Math.abs(m.atSec - wantAt);
      const score = -distance;
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    return best;
  };

  for (let i = 0; i < shots.length; i++) {
    let moment = moments.find((m) => m.atSec === shots[i].atSec);
    if (!moment) {
      // The shot names a moment that is not in the list (already swapped or
      // nudged). Treat whatever it points at as its identity.
      moment =
        nearestFree(shots[i].atSec) ??
        moments.reduce((a, b) => (Math.abs(b.atSec - shots[i].atSec) < Math.abs(a.atSec - shots[i].atSec) ? b : a));
    }

    const previous = shots[i - 1];
    const tooClose =
      previous !== undefined && Math.abs(moment.atSec - previous.atSec) < MIN_SOURCE_GAP;

    if (used.has(moment.atSec) || tooClose) {
      const free = nearestFree(previous ? previous.atSec + MIN_SOURCE_GAP : moment.atSec);
      // Nothing free happens when the film holds fewer distinct moments than
      // the edit has slots. Then the old behaviour applies: keep the repeat,
      // and dedupeAdjacent will at least offset it so the cut stays visible.
      if (free) moment = free;
    }

    used.add(moment.atSec);
    shots[i] = { ...shots[i], atSec: moment.atSec, whatIsVisible: moment.whatIsVisible };
  }

  return shots;
}

/**
 * Breaks up runs of the same transition.
 *
 * The model is told to vary them and mostly does, but it settles into a
 * favourite over ten cuts. A run of identical transitions is the same failure
 * as cross-fading every beat: it stops being a choice and becomes a template.
 */
function varyTransitions(shots: Shot[]): Shot[] {
  // Ordered by how quietly each one reads, so a forced substitution never
  // lands on something louder than what the model actually asked for.
  const smooth: Transition[] = ["glide", "dissolve", "flash", "zoomBlur"];
  const out = [...shots];

  for (let i = 2; i < out.length; i++) {
    if (out[i].transition !== out[i - 1].transition) continue;
    if (out[i - 1].transition !== out[i - 2].transition) continue;

    const current = out[i].transition;
    const swap = smooth.find((t) => t !== current) ?? "glide";
    out[i] = { ...out[i], transition: swap };
  }

  // The first shot has nothing to arrive over.
  if (out.length > 0) out[0] = { ...out[0], transition: "cut" };
  return out;
}

/**
 * Gives each transition its length, clamped to the shot it belongs to.
 *
 * A half-second blend on a one-second shot means the shot is never once fully
 * itself, so the length gives way to the shot rather than the other way round.
 */
function timeTransitions(shots: Shot[]): Shot[] {
  return shots.map((shot, i) => {
    if (i === 0 || shot.transition === "cut") {
      return { ...shot, transition: i === 0 ? "cut" : shot.transition, transitionMs: 0 };
    }
    const span = shot.endMs - shot.startMs;
    const wanted = TRANSITION_MS[shot.transition] ?? 0;
    const allowed = Math.max(0, Math.min(wanted, span * 0.35));
    // Below about six frames nothing reads as a transition at all, so it
    // becomes an honest cut instead of a blur nobody sees.
    if (allowed < 200) return { ...shot, transition: "cut", transitionMs: 0 };
    return { ...shot, transitionMs: Math.round(allowed) };
  });
}

/** A second shot inside one line should not repeat the first one's move. */
function alternate(move: Move): Move {
  const swap: Record<Move, Move> = {
    push: "driftL",
    pull: "push",
    driftL: "driftR",
    driftR: "push",
    hold: "push",
    punch: "hold",
  };
  return swap[move] ?? "push";
}

/**
 * Nudges consecutive shots off the same source moment.
 *
 * Two identical shots back to back read as one long take with a glitch in the
 * middle - exactly the failure this whole step exists to remove. Offsetting
 * the second one keeps the cut visible when the film has nothing else to give.
 */
function dedupeAdjacent(shots: Shot[]): Shot[] {
  for (let i = 1; i < shots.length; i++) {
    if (Math.abs(shots[i].atSec - shots[i - 1].atSec) < 0.5) {
      shots[i] = { ...shots[i], atSec: shots[i].atSec + 2.5 };
    }
  }
  return shots;
}
