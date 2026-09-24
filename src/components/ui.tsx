import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { formatDelta } from "@/lib/format";

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-border bg-surface-1 ${className}`}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
      <div>
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {hint && <p className="mt-0.5 text-xs text-ink-3">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

/**
 * A single headline number. No plot, so no hover layer — the optional
 * sparkline slot below carries the trend as texture.
 */
export function StatTile({
  label,
  value,
  deltaPct,
  sparkline,
}: {
  label: string;
  value: string;
  deltaPct?: number | null;
  sparkline?: React.ReactNode;
}) {
  const dir =
    deltaPct === null || deltaPct === undefined
      ? "flat"
      : deltaPct > 0.05
        ? "up"
        : deltaPct < -0.05
          ? "down"
          : "flat";

  const Icon = dir === "up" ? ArrowUpRight : dir === "down" ? ArrowDownRight : Minus;
  const tone =
    dir === "up" ? "text-good" : dir === "down" ? "text-critical" : "text-ink-3";

  return (
    <Card className="p-4">
      <div className="text-xs font-medium text-ink-3">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="font-mono text-2xl font-semibold tracking-tight">{value}</span>
        {deltaPct !== undefined && (
          <span className={`flex items-center gap-0.5 text-xs font-medium ${tone}`}>
            <Icon className="h-3 w-3" />
            {formatDelta(deltaPct ?? null)}
          </span>
        )}
      </div>
      {sparkline && <div className="mt-3">{sparkline}</div>}
    </Card>
  );
}

const BADGE_TONES: Record<string, string> = {
  neutral: "bg-surface-3 text-ink-2 border-border-strong",
  good: "bg-good/12 text-good border-good/30",
  warn: "bg-warn/12 text-warn border-warn/30",
  critical: "bg-critical/12 text-critical border-critical/30",
  info: "bg-series-1/12 text-series-1 border-series-1/30",
};

export function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: keyof typeof BADGE_TONES | string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
        BADGE_TONES[tone] ?? BADGE_TONES.neutral
      }`}
    >
      {children}
    </span>
  );
}

export function EmptyState({
  title,
  body,
}: {
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-lg border border-dashed border-border-strong px-4 py-8 text-center">
      <p className="text-sm font-medium text-ink-2">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-xs text-ink-3">{body}</p>
    </div>
  );
}
