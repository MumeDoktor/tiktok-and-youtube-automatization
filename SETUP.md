# Setup

Two processes make up the system:

| Process | Command | What it does |
|---|---|---|
| Dashboard | `npm run dev` | The UI, the chat, the API routes |
| Worker | `npm run worker` | The autonomous loop: sync metrics, analyse the market, plan content |

Both must be running for the agents to work. The dashboard alone is read-only.

---

## 1. Claude API key (required)

1. Go to <https://console.anthropic.com> → **API keys** → create one.
2. Put it in `.env.local`:

   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```

Models used, set in `src/lib/env.ts`:

- `claude-opus-5` — market analysis and content planning (a few calls a day)
- `claude-sonnet-5` — the per-account chat and memory distillation

---

## 2. TikTok developer app

This is the part with a waiting period. Start it before anything else.

### 2.1 Register

1. <https://developers.tiktok.com> → log in with the TikTok account that will
   own the app → **Manage apps** → **Connect an app**.
2. Fill in the app details. Describe what the app actually does — "reads
   analytics for my own TikTok accounts and helps me plan content" is accurate
   for a read-only setup.
3. Add the product **Login Kit**. You only need **Content Posting API** if you
   later decide to let the app upload videos.

### 2.2 Scopes

This project is configured **read-only by default**. Request only these four:

| Scope | Needed for |
|---|---|
| `user.info.basic` | handle, display name, avatar |
| `user.info.profile` | profile deep link (the View on TikTok button) |
| `user.info.stats` | follower / like / video counts |
| `video.list` | per-video views, likes, comments, shares |

With these four, the app can read the account and **cannot post to it** - no
code path in the project can, because TikTok never granted the permission.

Do **not** request `video.upload` or `video.publish` unless you decide later
that you want the app to post. Requesting scopes you do not use also delays
app review, so ask for the smaller set.

If you change your mind later, add them to `TIKTOK_SCOPES` in `.env.local`,
add them in the portal, and reconnect the account.

### 2.3 Redirect URI — needs HTTPS, so you need a tunnel

TikTok requires redirect URIs for **web apps** to be absolute and begin with
`https`. `http://localhost:3000/...` is rejected. The URI must also be static —
no query string, no `#` fragment. Max 10 URIs per app, under 512 characters each.

Your app runs on localhost, so put an HTTPS tunnel in front of it. Use ngrok:
its free plan includes **one permanent static domain**, so the URI you register
with TikTok never changes.

The ngrok SDK is already wired in as `npm run tunnel`. You do not need the ngrok
CLI, and you do not need to paste any snippet from the ngrok dashboard.

1. Sign up at <https://ngrok.com> (free). Copy your authtoken from
   <https://dashboard.ngrok.com/get-started/your-authtoken>.

2. Add it to `.env.local`:

   ```
   NGROK_AUTHTOKEN=<your-token>
   ```

3. `.env.local` is already pointed at this project's static domain:

   ```
   TIKTOK_REDIRECT_URI=https://mandatory-unleaded-calculus.ngrok-free.dev/api/tiktok/callback
   APP_URL=https://mandatory-unleaded-calculus.ngrok-free.dev
   ```

   `npm run tunnel` reads the domain out of `TIKTOK_REDIRECT_URI`, so those two
   can never drift apart. Change the domain in one place and the tunnel follows.

4. Start it, and leave it running whenever you connect accounts:

   ```bash
   npm run tunnel
   ```

5. Register this exact string in TikTok's Login Kit settings:

   ```
   https://mandatory-unleaded-calculus.ngrok-free.dev/api/tiktok/callback
   ```

`APP_URL` must match the tunnel too — it is where you get redirected back to
after authorising.

`npm run doctor` distinguishes a *registered but offline* domain (ngrok answers
`ERR_NGROK_3200`) from a live one, so it will not tell you the tunnel is fine
when nothing is attached to it.

> The tunnel is only needed for the OAuth handshake and for TikTok to reach you.
> Once accounts are connected, the worker calls TikTok outbound and the tunnel
> can be off until you next connect an account.

**Alternative:** TikTok's *Login Kit for Desktop* does allow `http` with
`localhost` and a port. That would remove the tunnel, but it is a different app
type and I have not verified the Content Posting API behaves identically under
it — the tunnel is the known-good path.

### 2.4 Keys

Copy the client key and secret into `.env.local`:

```
TIKTOK_CLIENT_KEY=aw...
TIKTOK_CLIENT_SECRET=...
```

### 2.5 Sandbox — this is how you connect today

You do not have to wait for the audit to connect your accounts. Create a sandbox
and add them as target users.

1. **Manage apps** → your app → toggle to **Sandbox** → **Create Sandbox** →
   name it (e.g. `local-dev`).
2. In the sandbox, open **Target Users** and add both of your TikTok accounts.
   You have to sign in as each account and accept the Developer Terms of
   Service. Limits: **5 sandboxes per app, 10 target users per sandbox.**
3. Entries can take up to an hour to appear — refresh the page if they do not
   show immediately.
4. Use the **sandbox's** client key and secret in `.env.local` (they differ from
   the production app's).

What works in sandbox: the whole OAuth handshake, and reading profile and video
stats — everything a read-only setup needs. Public posting does not, but that is
irrelevant unless you enable posting scopes later.

### 2.6 The audit — only if you later want public posting

**If you are staying read-only, skip this section entirely.** No audit, no
demo video, no production review. Sandbox with read-only scopes covers
analytics, agents and chat indefinitely.


Until TikTok audits your app, `video.publish` will not work. Unaudited apps can
still upload, but the video lands in the account's **inbox as a private draft**
and a human has to open the TikTok app and tap post.

The agent has four autonomy levels, and the lower two never touch TikTok at all:

| Level | Behaviour | Scopes needed |
|---|---|---|
| `observe` | Analytics, market analysis, content plans, chat. Touches no video files, never contacts TikTok to post. | read-only |
| `suggest` | Also downloads and edits the video, leaving the finished MP4 on disk for you to post by hand. Still never contacts TikTok to post. | read-only |
| `draft` | Uploads the file to TikTok as a private draft — you tap post. | `video.upload` |
| `full` | Publishes publicly, unattended. | `video.publish` + audit |

Accounts start on `observe`. The dashboard and the API both refuse to select a
level the connected token cannot support, checked against the scopes TikTok
actually granted rather than local settings. With read-only scopes, `draft` and
`full` cannot be selected at all.

To apply for the audit: in the developer portal, submit the app for review with
a screen recording of the publishing flow (see `docs/app-review.md` and
`docs/demo-video.md`). Turnaround is usually days to a couple of weeks.

---

## 3. Local tooling

Already verified on this machine:

- **ffmpeg / ffprobe** — 8.0.1 ✓
- **yt-dlp** — installed via `python -m pip install yt-dlp` ✓
- **Node** — 22 ✓

`4K Video Downloader` is not used: it is a GUI app with no scriptable command
line. `yt-dlp` is the tool it wraps, and it is fully automatable.

Keep yt-dlp current — sites change and it breaks often:

```bash
python -m pip install --upgrade yt-dlp
```

---

## 4. First run

```bash
npm run db:push     # create tables (already done)
npm run db:seed     # create the two accounts + agents (already done)
npm run dev         # dashboard on localhost:3000
npm run tunnel      # second terminal - HTTPS tunnel for the OAuth handshake
npm run doctor      # third - verifies every prerequisite before you connect
```

`npm run doctor` checks the API key, the client key and secret, that the
redirect URI is HTTPS and static, that the tunnel is actually reachable, that
ffmpeg and yt-dlp work, and prints the connect link for each account. Fix
everything it marks `FAIL` before going further.

### Connecting the accounts

Do them one at a time. TikTok ties authorisation to the browser session, so:

1. Log into TikTok in your browser **as the first account**.
2. Dashboard → the account → **Connect TikTok** → authorise → you land back on
   the account page and the "demo data" badge disappears.
3. **Log out of TikTok**, or open a separate browser profile / private window,
   and log in **as the second account**.
4. Repeat for the second account.

The app forces TikTok's account picker (`disable_auto_auth=1`) rather than
silently reusing the session, and refuses to link the same TikTok account to
both rows — if you get "already connected as ...", you are still signed in as
the first account.

### Then

1. **Settings** on each account → set the real handle, niche, timezone, and the
   **content profile**. The content profile is the most important field in the
   system: it is what stops the agent inventing its own format.
2. **Sync metrics** — real numbers replace the seeded placeholders.
3. **Analyze market**, then **Plan content**.
4. `npm run worker` to hand it over to the agents.

After that the worker keeps going on its own: metrics every 3 hours, market
analysis daily, planning daily, then sourcing → editing → publishing at the
scheduled times.

---

## 5. Content rights

Every downloaded clip is stored with `rightsStatus = "unverified"`, and
**publishing refuses to touch an unverified clip**. This is deliberate.

Reposting other people's videos is the fastest way to collect copyright strikes
and lose the accounts you are trying to grow. To publish a clip you must set its
rights status to one of `own`, `licensed`, `cc`, or `permission` — i.e. state
that you actually have the right to use it.

The downloader records the uploader and any declared licence, and burns an
attribution line into the video when one is required.

---

## 6. Moving off your PC

The worker needs a machine that is on. To run 24/7 without your PC:

1. Put the repo on a small Linux VPS (~$5/mo is plenty).
2. `apt install ffmpeg && pip install yt-dlp`
3. Copy `.env.local`, run `npm run build && npm run start` and `npm run worker`
   under a process manager (`pm2`, `systemd`).
4. Point `APP_URL` and `TIKTOK_REDIRECT_URI` at the server's domain and add that
   redirect URI in the TikTok developer portal.

SQLite goes with the repo — there is no separate database to provision.
