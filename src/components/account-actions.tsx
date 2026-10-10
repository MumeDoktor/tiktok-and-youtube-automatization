"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2, RefreshCw, Sparkles, Wand2 } from "lucide-react";

type JobType = "sync" | "analyze" | "produce";

const ACTIONS: Array<{
  type: JobType;
  label: string;
  Icon: typeof RefreshCw;
  hint: string;
  primary?: boolean;
}> = [
  {
    type: "produce",
    label: "Make me a video",
    Icon: Wand2,
    hint: "Nova decides what to make and explains why, then finds an interview or archive footage and cuts it",
    primary: true,
  },
  { type: "sync", label: "Sync now", Icon: RefreshCw, hint: "Costs ~1 credit" },
  { type: "analyze", label: "Re-analyze", Icon: Sparkles, hint: "Free - reads stored data" },
];

export function AccountActions({ accountId }: { accountId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<JobType | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(type: JobType) {
    setBusy(type);
    setNote(null);
    setError(null);
    try {
      const res = await fetch(`/api/accounts/${accountId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `Failed (${res.status})`);
      setNote(
        json.queued
          ? type === "produce"
            ? "Started. Follow it under Clips below, where the reasoning shows up once Nova has decided what to make."
            : "Queued. The worker picks it up within a few seconds - watch the activity feed."
          : json.message,
      );
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {ACTIONS.map(({ type, label, Icon, hint, primary }) => (
          <button
            key={type}
            onClick={() => void run(type)}
            disabled={busy !== null || pending}
            title={hint}
            className={
              primary
                ? "inline-flex items-center gap-1.5 rounded-md bg-series-1 px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-40"
                : "inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-3 py-1.5 text-xs font-medium text-ink-2 transition hover:border-border-strong hover:text-ink disabled:opacity-40"
            }
          >
            {busy === type ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Icon className="h-3.5 w-3.5" />
            )}
            {label}
          </button>
        ))}
      </div>
      {note && <p className="text-xs text-ink-3">{note}</p>}
      {error && <p className="text-xs text-critical">{error}</p>}
    </div>
  );
}
