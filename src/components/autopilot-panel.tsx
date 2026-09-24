"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { CalendarClock, Loader2 } from "lucide-react";
import { Card, CardHeader } from "@/components/ui";
import type { AutopilotView } from "@/lib/queries";

function leadLabel(minutes: number): string {
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes} minutes`;
}

/**
 * The switch for autopilot, and what it has planned. The windows come from the
 * account's own numbers, so each one carries the figure it rests on.
 */
export function AutopilotPanel({ accountId, view }: { accountId: string; view: AutopilotView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/accounts/${accountId}/autopilot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !view.enabled }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `Failed (${res.status})`);
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const working = busy || pending;

  return (
    <Card className={view.enabled ? "border-series-1/25" : ""}>
      <CardHeader
        title="Autopilot"
        hint="Makes a video before each of your best posting times and notifies you when it is done"
        action={
          <button
            type="button"
            role="switch"
            aria-checked={view.enabled}
            onClick={() => void toggle()}
            disabled={working}
            className={
              view.enabled
                ? "inline-flex shrink-0 items-center gap-1.5 rounded-md bg-series-1 px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-40"
                : "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface-2 px-3 py-1.5 text-xs font-medium text-ink-2 transition hover:border-border-strong hover:text-ink disabled:opacity-40"
            }
          >
            {working && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {view.enabled ? "On" : "Off"}
          </button>
        }
      />

      <div className="space-y-3 px-4 py-3 text-xs leading-relaxed text-ink-2">
        {view.enabled && view.next && (
          <p className="flex items-start gap-2">
            <CalendarClock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-series-1" />
            {view.next.running ? (
              <span>
                Making the video for <span className="font-medium text-ink">{view.next.slot}</span>{" "}
                now. You will get a notification when it is ready.
              </span>
            ) : (
              <span>
                Next video for <span className="font-medium text-ink">{view.next.slot}</span>.
                Production starts {view.next.starts}, and you get a notification when it is ready.
              </span>
            )}
          </p>
        )}

        {view.enabled && !view.next && (
          <p className="text-warn">{view.blocked ?? "Planning the next slot..."}</p>
        )}

        {!view.enabled && (
          <p className="text-ink-3">
            When on, it makes {view.perWeek} video{view.perWeek === 1 ? "" : "s"} a week,{" "}
            {view.fixed ? "at the fixed times below" : "timed from this account's own numbers"}.
            Each one starts {leadLabel(view.leadMinutes)} before its slot
            {view.postsFromPhone
              ? ", and is posted through your phone when the slot comes."
              : ", and you get a Windows notification when it is ready. You still post it yourself."}
          </p>
        )}

        {view.windows.length > 0 && (
          <div>
            <p className="text-[11px] text-ink-3">
              {view.fixed ? "Posting times" : "Best times"} ({view.timezone})
            </p>
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {view.windows.map((w) => (
                <li
                  key={w.label}
                  title={w.why}
                  className="rounded-md border border-border bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-ink-2"
                >
                  {w.label}
                </li>
              ))}
            </ul>
            {view.evidence && <p className="mt-1.5 text-[11px] text-ink-3">{view.evidence}</p>}
          </div>
        )}

        {error && <p className="text-critical">{error}</p>}
      </div>
    </Card>
  );
}
