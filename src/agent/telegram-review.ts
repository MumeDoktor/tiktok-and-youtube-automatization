import fs from "node:fs";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { accounts, clips } from "@/db/schema";
import {
  AWAITING_KEY,
  awaitReasonFor,
  feedbackKey,
  getSetting,
  ownerChatId,
  rememberOwnerChat,
  setSetting,
  telegramCall,
  telegramEnabled,
  telegramText,
  telegramVideo,
} from "@/lib/telegram";
import { env } from "@/lib/env";
import { aeRunDir } from "@/lib/ae-editor";
import { enqueue } from "./events";
import { approveClip, rejectClip } from "./make";
import { rememberRejection } from "./revise";
import { approveReply, skipReply } from "./comments";

/**
 * Review from the phone: a finished export arrives in Telegram as the video,
 * with Approve / Reject under it, and a press does what `npm run approve` does.
 */

const OFFSET_KEY = "telegram:offset";

export async function sendForReview(clip: typeof clips.$inferSelect, file: string, durationSec: number) {
  if (!telegramEnabled()) return;
  const account = db.select().from(accounts).where(eq(accounts.id, clip.accountId)).get();
  let tags: string[] = [];
  try {
    tags = JSON.parse(clip.hashtags) as string[];
  } catch {
    tags = [];
  }
  // Each re-edit sets the previous build's result aside as result.<time>.json.
  let version = 1;
  try {
    version += fs.readdirSync(aeRunDir(clip.id)).filter((f) => /^result\.\d+\.json$/.test(f)).length;
  } catch {
    version = 1;
  }
  const caption = [
    `🎬 Ready for review${version > 1 ? ` (version ${version})` : ""}${account ? ` - @${account.handle}` : ""}`,
    `${clip.hookText || clip.sourceTitle || "Clip"} (${Math.round(durationSec)}s) - Approve posts it right away.`,
    clip.caption ? `\n${clip.caption}` : "",
    tags.length ? tags.map((t) => (t.startsWith("#") ? t : `#${t}`)).join(" ") : "",
  ]
    .filter(Boolean)
    .join("\n");
  await telegramVideo(file, caption, [
    [
      { text: "✅ Approve", callback_data: `approve:${clip.id}` },
      { text: "❌ Reject", callback_data: `reject:${clip.id}` },
    ],
  ]);
}

type Update = {
  update_id: number;
  message?: { chat: { id: number; type: string }; text?: string };
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number };
    message?: { chat: { id: number }; message_id: number; caption?: string; text?: string };
  };
};

let polling = false;

/**
 * Takes any button presses waiting in Telegram. Safe to call often: a call
 * while one is still running returns at once, and nothing here throws.
 */
export async function pollTelegram() {
  if (!telegramEnabled() || polling) return;
  polling = true;
  try {
    const offset = Number(getSetting(OFFSET_KEY) ?? 0);
    const updates = await telegramCall<Update[]>("getUpdates", {
      offset: offset || undefined,
      timeout: 0,
      allowed_updates: ["message", "callback_query"],
    });
    for (const u of updates) {
      // Moved past first, so an update that fails is not retried forever.
      setSetting(OFFSET_KEY, String(u.update_id + 1));
      try {
        await handle(u);
      } catch (e) {
        console.error("Telegram update failed:", e instanceof Error ? e.message : e);
      }
    }
  } catch (e) {
    console.error("Telegram poll failed:", e instanceof Error ? e.message : e);
  } finally {
    polling = false;
  }
}

async function handle(u: Update) {
  if (u.message) {
    const chat = String(u.message.chat.id);
    if (!ownerChatId() && u.message.chat.type === "private") {
      rememberOwnerChat(chat);
      telegramText("Connected. Finished videos will arrive here with Approve / Reject buttons.");
      return;
    }
    if (chat === ownerChatId() && u.message.text) takeReason(u.message.text);
    return;
  }

  const q = u.callback_query;
  if (!q?.data) return;
  // Only the owner's chat can approve anything.
  if (String(q.message?.chat.id ?? q.from.id) !== ownerChatId()) {
    await telegramCall("answerCallbackQuery", { callback_query_id: q.id, text: "Not allowed" });
    return;
  }

  const [action, clipId] = q.data.split(":");
  if (action === "done") {
    await telegramCall("answerCallbackQuery", { callback_query_id: q.id });
    return;
  }
  let result: string;
  let icon = "ℹ️";
  try {
    if (action === "approve") {
      result = approveClip(clipId);
      icon = "✅";
    } else if (action === "reject") {
      result = rejectClip(clipId);
      if (result.startsWith("rejected")) {
        icon = "❌";
        askWhy(clipId);
      }
    } else if (action === "creply" || action === "cskip") {
      // A drafted comment reply: clipId here is the comment's id.
      result = action === "creply" ? approveReply(clipId) : skipReply(clipId);
      icon = action === "creply" ? "✅" : "❌";
    } else if (action === "fix" || action === "new") {
      result = action === "fix" ? startFix(clipId) : startNew(clipId);
      icon = result.startsWith("nothing") ? "ℹ️" : action === "fix" ? "🔁" : "🆕";
    } else {
      result = "unknown button";
    }
  } catch (e) {
    result = e instanceof Error ? e.message : String(e);
    icon = "⚠️";
  }
  // A tap taken late (the worker was down) can no longer be answered, but it
  // has been acted on - the buttons below must still change to say so.
  await telegramCall("answerCallbackQuery", { callback_query_id: q.id, text: result.slice(0, 190) }).catch(() => {});

  // Swap the buttons for the outcome, so the message says what was decided.
  if (q.message) {
    const text = `${icon} ${result.charAt(0).toUpperCase()}${result.slice(1)}`.slice(0, 60);
    await telegramCall("editMessageReplyMarkup", {
      chat_id: q.message.chat.id,
      message_id: q.message.message_id,
      reply_markup: { inline_keyboard: [[{ text, callback_data: "done:" }]] },
    }).catch(() => {});
  }
}

/* After a Reject: why, then fix this one or make another --------------- */

function askWhy(clipId: string) {
  awaitReasonFor(clipId);
  telegramText(
    "What's wrong with it? Tell me in your own words.\n\n" +
      "If it's one moment, mention the time - like \"at 0:12 the text is too small\". " +
      "If it's the whole video, just say so - like \"too many effects\" or \"music too loud\".",
  );
}

/** A message from the owner: the reason for the last rejection, if one is wanted. */
function takeReason(text: string) {
  const clipId = getSetting(AWAITING_KEY);
  if (!clipId) {
    telegramText("Nothing is waiting for a reply right now. Finished videos arrive here with Approve / Reject buttons.");
    return;
  }
  const so_far = getSetting(feedbackKey(clipId)) ?? "";
  setSetting(feedbackKey(clipId), so_far ? `${so_far}\n${text}` : text);
  telegramText(
    so_far ? "Added. Send more, or choose:" : "Got it. Send more detail if you like, or choose:",
    [
      [
        { text: "🔁 Fix this video", callback_data: `fix:${clipId}` },
        { text: "🆕 Make a new video", callback_data: `new:${clipId}` },
      ],
    ],
  );
}

/** Takes the reason once; a second tap finds it gone and does nothing. */
function claimReason(clipId: string): { accountId: string; feedback: string } | null {
  const feedback = getSetting(feedbackKey(clipId));
  const clip = db.select().from(clips).where(eq(clips.id, clipId)).get();
  if (!feedback || !clip) return null;
  setSetting(feedbackKey(clipId), "");
  if (getSetting(AWAITING_KEY) === clipId) setSetting(AWAITING_KEY, "");
  return { accountId: clip.accountId, feedback };
}

function startFix(clipId: string): string {
  const got = claimReason(clipId);
  if (!got) return "nothing to do - already started";
  enqueue({ accountId: got.accountId, type: "revise_ae", payload: { clipId, feedback: got.feedback }, maxAttempts: 2 });
  return "fixing this video - it comes back here";
}

function startNew(clipId: string): string {
  const got = claimReason(clipId);
  if (!got) return "nothing to do - already started";
  rememberRejection(got.accountId, clipId, got.feedback);
  enqueue({ accountId: got.accountId, type: "make_video" });
  telegramText("🆕 Making a different video. Your reason is saved so it won't repeat the mistake.");
  return "making a new video";
}

export function telegramStatus(): string {
  if (!env.telegramBotToken) return "off (set TELEGRAM_BOT_TOKEN)";
  return ownerChatId() ? "on" : "waiting - send your bot any message to connect";
}
