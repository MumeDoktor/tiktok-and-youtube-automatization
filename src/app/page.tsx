import Link from "next/link";
import { Bot, ChevronRight, Pause, Play } from "lucide-react";
import { Sparkline } from "@/components/charts";
import { Badge, Card, EmptyState } from "@/components/ui";
import { compact, formatDelta, relativeTime } from "@/lib/format";
import { getAccountSummaries } from "@/lib/queries";

export const dynamic = "force-dynamic";

function DeltaText({ value }: { value: number | null }) {
  if (value === null) return <span className="text-ink-3">-</span>;
  const tone = value > 0 ? "text-good" : value < 0 ? "text-critical" : "text-ink-3";
  return <span className={tone}>{formatDelta(value)}</span>;
}

export default function DashboardPage() {
  const summaries = getAccountSummaries();

  const totals = summaries.reduce(
    (acc, s) => ({
      followers: acc.followers + s.followers,
      views: acc.views + s.totalViews,
      likes: acc.likes + s.likes,
    }),
    { followers: 0, views: 0, likes: 0 },
  );

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Accounts</h1>
          <p className="mt-1 text-sm text-ink-3">
            {summaries.length} account{summaries.length === 1 ? "" : "s"} &middot;{" "}
            {compact(totals.followers)} followers &middot; {compact(totals.views)} total
            views &middot; {compact(totals.likes)} likes
          </p>
        </div>
      </div>

      {summaries.length === 0 ? (
        <EmptyState
          title="No accounts yet"
          body="Run npm run db:seed to create your two accounts and their agents."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {summaries.map((s) => (
            <Link key={s.id} href={`/accounts/${s.id}`} className="group block">
              <Card className="p-5 transition hover:border-border-strong">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate font-semibold tracking-tight">
                        @{s.handle}
                      </h2>
                      {s.status === "paused" && <Badge tone="warn">paused</Badge>}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-ink-3">
                      {s.niche || "No niche set"}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-ink-3 transition group-hover:translate-x-0.5 group-hover:text-ink-2" />
                </div>

                <div className="mt-4 flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2">
                  <Bot className="h-3.5 w-3.5 text-series-1" />
                  <span className="text-xs font-medium">{s.agentName ?? "No agent"}</span>
                  <Badge tone={s.agentStatus === "active" ? "good" : "neutral"}>
                    {s.agentStatus === "active" ? (
                      <Play className="h-2.5 w-2.5" />
                    ) : (
                      <Pause className="h-2.5 w-2.5" />
                    )}
                    {s.agentStatus ?? "none"}
                  </Badge>
                  <span className="ml-auto text-[11px] text-ink-3">
                    ran {relativeTime(s.lastRunAt)}
                  </span>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-4">
                  <div>
                    <div className="text-[11px] text-ink-3">Followers</div>
                    <div className="mt-0.5 font-mono text-lg font-semibold">
                      {compact(s.followers)}
                    </div>
                    <div className="text-[11px]">
                      <DeltaText value={s.followersDelta7d} />
                      <span className="ml-1 text-ink-3">7d</span>
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-ink-3">Views</div>
                    <div className="mt-0.5 font-mono text-lg font-semibold">
                      {compact(s.totalViews)}
                    </div>
                    <div className="text-[11px]">
                      <DeltaText value={s.viewsDelta7d} />
                      <span className="ml-1 text-ink-3">7d</span>
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-ink-3">Likes</div>
                    <div className="mt-0.5 font-mono text-lg font-semibold">
                      {compact(s.likes)}
                    </div>
                    <div className="text-[11px]">
                      <DeltaText value={s.likesDelta7d} />
                      <span className="ml-1 text-ink-3">7d</span>
                    </div>
                  </div>
                </div>

                {s.series.length > 1 && (
                  <div className="mt-3">
                    <Sparkline data={s.series} />
                    <div className="mt-1 text-[10px] text-ink-3">Followers, last 30 days</div>
                  </div>
                )}
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
