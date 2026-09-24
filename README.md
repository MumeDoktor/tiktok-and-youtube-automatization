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
npm run dev          # dashboard  -> http://localhost:3000
npm run worker       # autonomous loop (second terminal)
```

Full instructions, including how to get TikTok API access:
**[SETUP.md](./SETUP.md)**

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
