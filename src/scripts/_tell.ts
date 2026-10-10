// One-off: send the owner a Telegram message from outside the worker - for
// when the worker itself is what stopped.
//   npx tsx src/scripts/_tell.ts "The worker stopped: ..."
import "../worker/load-env";

import { ownerChatId, telegramCall } from "../lib/telegram";

async function main() {
  const text = process.argv.slice(2).join(" ").trim();
  if (!text) throw new Error('usage: npx tsx src/scripts/_tell.ts "<message>"');
  const chatId = ownerChatId();
  if (!chatId) throw new Error("No Telegram chat is connected yet");
  await telegramCall("sendMessage", { chat_id: chatId, text: text.slice(0, 4000) });
  console.log("sent");
}

void main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
