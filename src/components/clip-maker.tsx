"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { CalendarClock, Download, Film, Loader2, XCircle } from "lucide-react";

export type ClipRow = {
  id: string;
  sourceUrl: string;
  sourceTitle: string | null;
  sourceUploader: string | null;
  startSec: number | null;
  endSec: number | null;
  hookText: string | null;
  caption: string | null;
  hashtags: string[];
  rationale: string | null;
  quote: string | null;
  outputDurationSec: number | null;
  sizeBytes: number | null;
  status: string;
  error: string | null;
  progress: Array<{ at: number; message: string }>;
  createdAt: number;
  /** The posting slot autopilot made this for, e.g. "Sat 7:00 PM". */
  scheduledLabel?: string | null;
  /** Where the edit waits in After Effects, once the editor has built it. */
  ae?: { comp: string; aep: string; exportDir: string } | null;
};

/** A video asked for that has no clip row yet. */
export type StartingJob = { id: string; type: string; status: string; stalled: boolean };

const STARTING_LABEL: Record<string, string> = {
  produce: "Starting a video",
  autopilot: "Starting a scheduled video",
  find_source: "Looking for an interview to cut",
};

const RUNNING = [
  "deciding",
  "queued",
  "transcribing",
  "choosing",
  "scripting",
  "voicing",
  "looking",
  "downloading",
  "editing",
];
/** Not working, but not finished either: waiting on After Effects, or on you. */
const AWAITING = ["waiting_for_ae", "review_in_ae"];

const STAGE_LABEL: Record<string, string> = {
  deciding: "Deciding what to make",
  queued: "Waiting to start",
  transcribing: "Reading the transcript",
  choosing: "Choosing a source",
  scripting: "Writing the narration",
  voicing: "Recording the voice",
  looking: "Watching the footage",
  downloading: "Downloading",
  editing: "Cutting and framing",
  ready: "Ready",
  declined: "Nothing worth cutting",
  failed: "Failed",
  posted: "Posted",
  waiting_for_ae: "Waiting for After Effects",
  review_in_ae: "Review in After Effects",
};

/**
 * Shows what the agent has produced. There is no form here on purpose - videos
 * are asked for in the conversation, and this is where they arrive.
 */
export function ClipList({
  clips,
  starting = [],
}: {
  clips: ClipRow[];
  starting?: StartingJob[];
}) {
  const router = useRouter();
  const working = starting.length > 0 || clips.some((c) => RUNNING.includes(c.status));
  const awaiting = clips.some((c) => AWAITING.includes(c.status));

  // While something is in flight the row changes underneath us, so poll. An
  // edit waiting on After Effects or on a review changes rarely, so slowly.
  useEffect(() => {
    if (!working && !awaiting) return;
    const t = setInterval(() => router.refresh(), working ? 2500 : 10_000);
    return () => clearInterval(t);
  }, [working, awaiting, router]);

  if (clips.length === 0 && starting.length === 0) {
    return (
      <div className="p-6 text-center">
        <Film className="mx-auto h-6 w-6 text-ink-3" />
        <p className="mt-2 text-sm text-ink-2">Nothing made yet</p>
        <p className="mx-auto mt-1 max-w-xs text-xs text-ink-3">
          Ask for a video in the chat. Anything it makes shows up here, ready to
          download and post.
        </p>
      </div>
    );
  }

  return (
    <ul className="max-h-[560px] divide-y divide-border overflow-y-auto">
      {starting.map((job) => (
        <li key={job.id} className="p-3">
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
              job.stalled
                ? "border-warn/30 bg-warn/12 text-warn"
                : "border-border-strong bg-surface-3 text-ink-2"
            }`}
          >
            {!job.stalled && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
            {STARTING_LABEL[job.type] ?? "Starting"}
          </span>
          <p className={`mt-1.5 text-[11px] ${job.stalled ? "text-warn" : "text-ink-3"}`}>
            {job.stalled
              ? "Still waiting for the worker to pick this up. Is npm run dev (or npm run worker) running?"
              : job.status === "running"
                ? "Searching for a source. The clip shows up here once one is chosen."
                : "Queued. The worker picks it up within a few seconds."}
          </p>
        </li>
      ))}
      {clips.map((clip) => (
        <li key={clip.id} className="p-3">
          <div className="flex items-start gap-3">
            {clip.status === "ready" && (
              <a
                href={`/api/clips/${clip.id}/file`}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/clips/${clip.id}/file?thumb=1`}
                  alt=""
                  className="h-20 w-[45px] rounded object-cover"
                />
              </a>
            )}

            <div className="min-w-0 flex-1">
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                  clip.status === "ready"
                    ? "border-good/30 bg-good/12 text-good"
                    : clip.status === "declined"
                      ? "border-warn/30 bg-warn/12 text-warn"
                      : clip.status === "failed"
                        ? "border-critical/30 bg-critical/12 text-critical"
                        : clip.status === "review_in_ae"
                          ? "border-series-1/30 bg-series-1/12 text-series-1"
                          : clip.status === "waiting_for_ae"
                            ? "border-warn/30 bg-warn/12 text-warn"
                            : "border-border-strong bg-surface-3 text-ink-2"
                }`}
              >
                {RUNNING.includes(clip.status) && (
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                )}
                {clip.status === "declined" && <XCircle className="h-2.5 w-2.5" />}
                {STAGE_LABEL[clip.status] ?? clip.status}
              </span>
              {clip.scheduledLabel && (
                <span className="ml-1.5 inline-flex items-center gap-1 rounded-full border border-series-1/30 bg-series-1/12 px-2 py-0.5 text-[10px] font-medium text-series-1">
                  <CalendarClock className="h-2.5 w-2.5" />
                  Post {clip.scheduledLabel}
                </span>
              )}

              {clip.hookText && (
                <p className="mt-1.5 text-sm font-medium leading-snug text-ink">
                  {clip.hookText}
                </p>
              )}
              {clip.caption && clip.caption !== clip.hookText && (
                <p className="mt-1 text-xs text-ink-2">{clip.caption}</p>
              )}
              {clip.hashtags.length > 0 && (
                <p className="mt-1 font-mono text-[11px] text-series-1">
                  {clip.hashtags.map((h) => `#${h}`).join(" ")}
                </p>
              )}
              {clip.rationale && (
                <p className="mt-1.5 whitespace-pre-line text-[11px] leading-relaxed text-ink-3">
                  {clip.rationale.length > 260
                    ? `${clip.rationale.slice(0, 260)}...`
                    : clip.rationale}
                </p>
              )}
              {clip.progress.length > 0 && (
                <ol className="mt-2 space-y-1 border-l border-border pl-3">
                  {clip.progress.map((step, i) => {
                    const isLast = i === clip.progress.length - 1;
                    const live = isLast && RUNNING.includes(clip.status);
                    return (
                      <li
                        key={`${step.at}-${i}`}
                        className={`relative text-[11px] leading-relaxed ${
                          live ? "text-ink-2" : "text-ink-3"
                        }`}
                      >
                        <span
                          className={`absolute -left-[15px] top-[6px] h-1.5 w-1.5 rounded-full ${
                            live ? "bg-series-1 pulse-dot" : "bg-border-strong"
                          }`}
                        />
                        {step.message}
                      </li>
                    );
                  })}
                </ol>
              )}

              {clip.error && (
                <p className="mt-1.5 text-[11px] text-critical">{clip.error}</p>
              )}

              {clip.status === "review_in_ae" && clip.ae && (
                <div className="mt-2 rounded-md border border-series-1/30 bg-series-1/12 p-2 text-[11px] leading-relaxed text-ink-2">
                  <p className="font-medium text-ink">Waiting for your review in After Effects</p>
                  <p className="mt-1">
                    Open <span className="break-all font-mono">{clip.ae.aep}</span>, comp{" "}
                    <span className="font-mono">{clip.ae.comp}</span>.
                  </p>
                  <p className="mt-1">
                    Export into <span className="break-all font-mono">{clip.ae.exportDir}</span>{" "}
                    and it is picked up here automatically.
                  </p>
                </div>
              )}

              {clip.status === "ready" && (
                <a
                  href={`/api/clips/${clip.id}/file`}
                  download={`clip-${clip.id}.mp4`}
                  className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border-strong px-2.5 py-1 text-[11px] font-medium text-ink-2 transition hover:text-ink"
                >
                  <Download className="h-3 w-3" />
                  Download
                  {clip.outputDurationSec
                    ? ` · ${Math.round(clip.outputDurationSec)}s`
                    : ""}
                  {clip.sizeBytes
                    ? ` · ${(clip.sizeBytes / 1024 / 1024).toFixed(1)}MB`
                    : ""}
                </a>
              )}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
