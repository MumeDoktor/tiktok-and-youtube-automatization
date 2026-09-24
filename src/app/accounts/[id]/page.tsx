import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Bot, ExternalLink } from "lucide-react";
import { AccountActions } from "@/components/account-actions";
import { AutopilotPanel } from "@/components/autopilot-panel";
import { LineChart, Sparkline } from "@/components/charts";
import { AgentChat, type ChatTurn } from "@/components/chat";
import { ClipList } from "@/components/clip-maker";
import { Badge, Card, CardHeader, EmptyState, StatTile } from "@/components/ui";
import { loadHistory } from "@/agent/chat";
import { compact, full, relativeTime } from "@/lib/format";
import { getAccountDetail } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function AccountPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const detail = getAccountDetail(id);
  if (!detail) notFound();

  const { account, agent, snaps, latest, deltas, videos, clips, starting, analysis, autopilot } =
    detail;
  const read = analysis?.read;

  const history: ChatTurn[] = loadHistory(id).map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt.getTime(),
  }));

  const followerSeries = snaps.map((s) => ({ t: s.capturedAt.getTime(), v: s.followers }));
  const viewSeries = snaps.map((s) => ({ t: s.capturedAt.getTime(), v: s.totalViews }));

  const median =
    videos.length > 0
      ? [...videos.map((v) => v.views)].sort((a, b) => a - b)[Math.floor(videos.length / 2)]
      : 0;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-xs text-ink-3 transition hover:text-ink-2"
        >
          <ArrowLeft className="h-3 w-3" />
          All accounts
        </Link>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">@{account.handle}</h1>
          {account.profileDeepLink && (
            <a
              href={account.profileDeepLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-ink-2 transition hover:border-border-strong hover:text-ink"
            >
              <ExternalLink className="h-3 w-3" />
              View on TikTok
            </a>
          )}
        </div>
        <p className="mt-1 text-sm text-ink-3">{account.niche || "No niche set"}</p>
        <div className="mt-4">
          <AccountActions accountId={account.id} />
        </div>
      </div>

      {/* ---------- 1. Make a video - the whole point of the page ---------- */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-3">
          Make a video
        </h2>

        <AutopilotPanel accountId={account.id} view={autopilot} />

        <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
          <Card className="overflow-hidden border-series-1/25">
            <CardHeader
              title={`Talk to ${agent?.name ?? "your agent"}`}
              hint="Ask for a video and it gets made in this conversation"
              action={
                <Badge tone={agent?.status === "active" ? "good" : "neutral"}>
                  <Bot className="h-2.5 w-2.5" />
                  {agent?.status ?? "none"}
                </Badge>
              }
            />
            <AgentChat
              accountId={account.id}
              agentName={agent?.name ?? "Agent"}
              initialMessages={history}
            />
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="Clips" hint="What it has made for you" />
            <ClipList clips={clips} starting={starting} />
          </Card>
        </div>
      </section>

      {/* ---------- 2. Audience ---------- */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-3">
          Audience
        </h2>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Followers"
            value={full(latest?.followers ?? 0)}
            deltaPct={deltas.followers}
            sparkline={
              followerSeries.length > 1 ? (
                <Sparkline data={followerSeries} color="var(--color-series-1)" />
              ) : undefined
            }
          />
          <StatTile
            label="Total views"
            value={full(latest?.totalViews ?? 0)}
            deltaPct={deltas.views}
            sparkline={
              viewSeries.length > 1 ? (
                <Sparkline data={viewSeries} color="var(--color-series-2)" />
              ) : undefined
            }
          />
          <StatTile
            label="Total likes"
            value={full(latest?.likes ?? 0)}
            deltaPct={deltas.likes}
          />
          <StatTile label="Median views per video" value={full(median)} />
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader title="Followers" hint="Last 30 days" />
            <div className="p-3">
              {followerSeries.length > 1 ? (
                <LineChart
                  data={followerSeries}
                  label="Followers"
                  color="var(--color-series-1)"
                />
              ) : (
                <EmptyState
                  title="Not enough history yet"
                  body="A trend needs two or more daily snapshots. The worker adds one per day."
                />
              )}
            </div>
          </Card>
          <Card>
            <CardHeader title="Total views" hint="Last 30 days" />
            <div className="p-3">
              {viewSeries.length > 1 ? (
                <LineChart data={viewSeries} label="Views" color="var(--color-series-2)" />
              ) : (
                <EmptyState
                  title="Not enough history yet"
                  body="A trend needs two or more daily snapshots. The worker adds one per day."
                />
              )}
            </div>
          </Card>
        </div>

        {read && (
          <Card className="border-series-1/25 p-5">
            <p className="text-[11px] font-medium uppercase tracking-wide text-ink-3">
              What {agent?.name ?? "the agent"} makes of it
            </p>
            <p className="mt-2 text-sm leading-relaxed text-ink-2">{read.summary}</p>
          </Card>
        )}
      </section>

      {/* ---------- 3. Your videos ---------- */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-3">
          Your videos
        </h2>
        <Card>
          <CardHeader
            title={`${videos.length} videos`}
            hint="Most viewed first · click through to TikTok"
          />
          <div className="max-h-[520px] divide-y divide-border overflow-y-auto">
            {videos.length === 0 && (
              <div className="p-4">
                <EmptyState
                  title="No videos synced yet"
                  body="Click Sync now to pull them from TikTok."
                />
              </div>
            )}
            {videos.map((v) => (
              <div key={v.id} className="flex items-start gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm text-ink-2">
                    {v.caption || "(no caption)"}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-ink-3">
                    <span>{v.publishedAt ? relativeTime(v.publishedAt) : "date unknown"}</span>
                    {v.durationSec ? <span>{Math.round(v.durationSec)}s</span> : null}
                    <span>{compact(v.likesCount)} likes</span>
                    <span>{compact(v.comments)} comments</span>
                    <span>{compact(v.shares)} shares</span>
                    {v.saves > 0 && <span>{compact(v.saves)} saves</span>}
                  </div>
                  {v.shareUrl && (
                    <a
                      href={v.shareUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-flex items-center gap-1 text-[11px] text-series-1 hover:underline"
                    >
                      <ExternalLink className="h-3 w-3" />
                      Open
                    </a>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-mono text-base font-semibold tabular-nums">
                    {compact(v.views)}
                  </div>
                  <div className="text-[10px] text-ink-3">views</div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </section>

    </div>
  );
}
