import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { settings } from "@/db/schema";
import { env } from "@/lib/env";
import { probe, run, splitCmd } from "@/lib/media";

/**
 * The owner's phone, through a Telegram bot.
 *
 * Telegram is pulled, never pushed to: the worker asks for new button presses
 * (getUpdates), so nothing on this machine is reachable from the internet.
 * Only the owner's chat is ever written to or listened to - TELEGRAM_CHAT_ID,
 * or else the first chat that messages the bot, remembered in settings.
 */

/** Bots may upload up to 50MB; anything bigger goes as a smaller review copy. */
const MAX_UPLOAD_BYTES = 49 * 1024 * 1024;
const CHAT_KEY = "telegram:chatId";

export type InlineButton = { text: string; callback_data: string };

export function telegramEnabled(): boolean {
  return !!env.telegramBotToken;
}

function getSetting(key: string): string | undefined {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value;
}

export function setSetting(key: string, value: string) {
  if (getSetting(key) === undefined) db.insert(settings).values({ key, value }).run();
  else db.update(settings).set({ value }).where(eq(settings.key, key)).run();
}

export { getSetting };

/** After a Reject: which clip the owner's next message is the reason for. */
export const AWAITING_KEY = "telegram:awaitingReason";
export const feedbackKey = (clipId: string) => `feedback:${clipId}`;

/** Takes the owner's next messages as the reason for rejecting this clip. */
export function awaitReasonFor(clipId: string, soFar = "") {
  setSetting(AWAITING_KEY, clipId);
  setSetting(feedbackKey(clipId), soFar);
}

export function ownerChatId(): string | undefined {
  return env.telegramChatId ?? getSetting(CHAT_KEY);
}

export function rememberOwnerChat(chatId: string) {
  setSetting(CHAT_KEY, chatId);
}

export async function telegramCall<T = unknown>(method: string, body: Record<string, unknown> | FormData): Promise<T> {
  const url = `https://api.telegram.org/bot${env.telegramBotToken}/${method}`;
  const res = await fetch(
    url,
    body instanceof FormData
      ? { method: "POST", body }
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description ?? res.status}`);
  return json.result as T;
}

const keyboard = (buttons?: InlineButton[][]) => (buttons ? { inline_keyboard: buttons } : undefined);

/** Fire and forget: a message that fails to send must never fail the work. */
export function telegramText(text: string, buttons?: InlineButton[][]) {
  const chatId = ownerChatId();
  if (!telegramEnabled() || !chatId) return;
  telegramCall("sendMessage", {
    chat_id: chatId,
    text: text.slice(0, 4000),
    reply_markup: keyboard(buttons),
  }).catch((e) => console.error("Telegram message failed:", e instanceof Error ? e.message : e));
}

/**
 * A copy of an export small enough to upload, for watching on the phone only -
 * TikTok still gets the original.
 *
 * Exports are near-lossless (CRF 16), so anything past about a minute is over
 * the cap, and a message that says "watch it on the PC" is no review at all
 * for someone who is not at the PC. The bitrate is worked out from the length
 * so the copy lands under the cap whatever the video runs to.
 */
async function reviewCopy(file: string): Promise<string> {
  const { durationSec } = await probe(file);
  if (!durationSec) throw new Error(`${file} has no duration`);
  const audioKbps = 96;
  const videoKbps = Math.min(
    2500,
    Math.floor((MAX_UPLOAD_BYTES * 0.85 * 8) / durationSec / 1000) - audioKbps,
  );
  if (videoKbps < 200) throw new Error(`${Math.round(durationSec)}s is too long to fit a review copy`);
  const out = path.join(os.tmpdir(), `review-${path.basename(file, path.extname(file))}-${Date.now()}.mp4`);
  const { bin, prefix } = splitCmd(env.ffmpeg);
  await run(
    bin,
    [
      ...prefix,
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", file,
      "-vf", "scale=720:-2",
      "-c:v", "libx264", "-preset", "veryfast",
      "-b:v", `${videoKbps}k`, "-maxrate", `${videoKbps}k`, "-bufsize", `${videoKbps * 2}k`,
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      "-c:a", "aac", "-b:a", `${audioKbps}k`,
      out,
    ],
    { timeoutMs: 10 * 60_000 },
  );
  return out;
}

/** Sends a video to play on the phone - a smaller copy of it when it is too big to upload. */
export async function telegramVideo(file: string, caption: string, buttons?: InlineButton[][]) {
  const chatId = ownerChatId();
  if (!telegramEnabled() || !chatId) return;
  let copy: string | null = null;
  try {
    const size = fs.statSync(file).size;
    if (size > MAX_UPLOAD_BYTES) copy = await reviewCopy(file);
    const form = new FormData();
    form.set("chat_id", chatId);
    form.set("caption", caption.slice(0, 1000));
    form.set("supports_streaming", "true");
    if (buttons) form.set("reply_markup", JSON.stringify(keyboard(buttons)));
    form.set("video", await fs.openAsBlob(copy ?? file, { type: "video/mp4" }), path.basename(file));
    await telegramCall("sendVideo", form);
  } catch (e) {
    console.error("Telegram video failed:", e instanceof Error ? e.message : e);
    telegramText(`${caption}\n\n(video upload failed - watch it at ${file})`, buttons);
  } finally {
    if (copy) fs.rmSync(copy, { force: true });
  }
}

/** Sends a picture - the phone's screen when a post is stuck - falling back to text. */
export async function telegramPhoto(file: string, caption: string) {
  const chatId = ownerChatId();
  if (!telegramEnabled() || !chatId) return;
  try {
    const form = new FormData();
    form.set("chat_id", chatId);
    form.set("caption", caption.slice(0, 1000));
    form.set("photo", await fs.openAsBlob(file, { type: "image/png" }), path.basename(file));
    await telegramCall("sendPhoto", form);
  } catch (e) {
    console.error("Telegram photo failed:", e instanceof Error ? e.message : e);
    telegramText(`${caption}\n\n(screenshot at ${file})`);
  }
}
