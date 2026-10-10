# TikTok Agent Control

Two TikTok accounts, one agent each. Every agent tracks its account's
analytics, researches its niche, and plans videos inside a content format you
define — on a schedule derived from that account's own performance data. You
talk to each agent in its own chat, and what you tell it there sticks.

Read-only by default: the agents observe and plan, and cannot post. Uploading
and publishing are opt-in levels you can enable later.

Built for a US audience. Runs locally; lifts to a VPS unchanged.

## Stack

Next.js 15 (App Router) · SQLite + Drizzle · Claude Opus 5 / Sonnet 5 ·
yt-dlp · ffmpeg

## Quick start

```bash
npm install
npm run db:push      # create tables
npm run db:seed      # create 2 accounts + 2 agents
npm run dev          # dashboard and autonomous worker together
```

Full instructions, including how to get TikTok API access:
**[SETUP.md](./SETUP.md)**

## Claude subscription → Codex → Claude publishing

With `EDITOR_BACKEND=codex`, the scheduled worker asks the locally signed-in
Claude subscription to find and choose a podcast beat. It downloads that beat,
then starts the locally signed-in Codex CLI to write and render a vertical
podcast/visual-story edit. A successful render is checked for audio, vertical
video, and duration. With `PUBLISH_BACKEND=claude` and `PHONE_PUBLISH=on`, the
worker immediately gives the finished MP4 path, caption and scheduled posting
time to a signed-in Claude background session. Codex ends its work at that
handoff. Claude owns publishing; the worker does not operate the phone or mark
the clip posted. `PHONE_DRY_RUN` applies only to the separate direct phone
backend.

Run `claude auth login` and `codex login` once for the Windows user that runs
the worker. Start the worker with `npm run dev` (dashboard too) or
`npm run worker` (worker only). Restart it after changing `.env.local`.
Each Codex job saves `final.mp4` and `codex.log` under
`../ai_aget_ae/runs/codex-jobs/<clipId>/` so failures can be inspected and
successful renders can be reused after a restart.

## Making and posting videos (review first)

```bash
npm run make -- sciencelabaratory      # queue one video (the worker makes it)
npm run make -- norex055 --now         # or start it here, in the foreground
npm run review                         # what is being made / waiting for you / posted
npm run approve -- <clipId>            # OK it: exported if needed, then posted
npm run phone:account -- --account norex055   # switch the phone and verify
```

Every video stops for your review; nothing posts without `npm run approve`,
autopilot slots included. An approved video posts through the phone to its
**own** account: the driver switches accounts (Profile menu -> Settings and
privacy -> Switch account) and refuses to post unless the Profile tab then shows
exactly that handle. The phone must be plugged in with a swipe-only lock (no
PIN).

Where each account's videos come from is set per account in the `settings`
table:

| key | example | meaning |
|---|---|---|
| `library_dir:<accountId>` | `C:/.../Valor Unleashed` | folder of finished clips to post from (edited motion-only) |
| `library_share:<accountId>` | `0.75` | share of videos drawn from the folder; the rest are original narrated |
| `formats:<accountId>` | `archive` | formats the decision may pick (`archive` = original narrated only) |
| `clip_min_sec:<accountId>` / `clip_max_sec:<accountId>` | `58` / `36` | length window (After Effects edits aim at min/0.85 .. max*2.5) |

Library clips are picked from those not yet posted, scored against the
account's best-performing captions. Restart the worker after changing code.

## How it works

```
                 ┌──────────────── worker loop ────────────────┐
                 │                                             │
  every 3h   ──▶ refresh_metrics ──▶ TikTok API ──▶ snapshots  │
  daily      ──▶ analyze_market  ──▶ Opus 5 + web search       │
  daily      ──▶ plan_content    ──▶ Opus 5 ──▶ posts + slots  │
                        │                                      │
                        ▼                                      │
                   source_video ──▶ yt-dlp   ──▶ content_item  │
                        ▼                                      │
                   edit_video   ──▶ ffmpeg   ──▶ 1080x1920 mp4 │
                        ▼                                      │
                   publish      ──▶ TikTok Content Posting API │
                 │                                             │
                 └─────────────────────────────────────────────┘
```

Every step is a row in `jobs` with retries and exponential backoff, so a failed
download or a TikTok hiccup never wedges the pipeline.

## Agent memory

Three layers, all injected on every agent call — chat and autonomous runs alike:

1. **Content profile** — the format you defined. Binding; the agent picks topics
   inside it and never changes it.
2. **Standing memory** — durable directives distilled out of your chats
   automatically. Say "stop using trending audio" once and it holds.
3. **Live data** — current metrics, recent post performance, latest market read.

Raw chat history replays verbatim on top of that, so the agent is aware of both
the detail of recent conversations and the substance of old ones.

## Autonomy levels

| Level | Behaviour | Touches TikTok? |
|---|---|---|
| `observe` | Analytics, market analysis, content plans, chat | read only |
| `suggest` | Also downloads and edits the video, leaving the file for you | read only |
| `draft` | Uploads as a private draft — you tap post | needs `video.upload` |
| `full` | Publishes publicly, unattended | needs audit |

Accounts start on `observe`, and the app requests **read-only scopes by
default** — so it can see your accounts and cannot post to them.

## Safety rails

- Clips download with `rightsStatus = "unverified"`; publishing refuses them
  until you assert you hold the rights.
- Autonomy cannot be set above what TikTok actually granted. With read-only
  scopes, `draft` and `full` are refused by both the UI and the API.
- The agent is instructed to report numbers only from live data, and to say when
  it does not have something rather than guess.
