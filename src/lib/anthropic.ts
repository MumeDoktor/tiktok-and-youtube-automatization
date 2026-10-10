import Anthropic from "@anthropic-ai/sdk";
import { requireAnthropicKey } from "./env";

let client: Anthropic | undefined;

/**
 * The paid API, billed to ANTHROPIC_API_KEY. Off unless PAID_API=on.
 *
 * Every pipeline call goes through the owner's Claude subscription
 * (claude-subscription.ts); this is left only for the dashboard chat's
 * streaming tool loop, which the subscription transport cannot carry. An API
 * balance ran dry once without anyone knowing what was spending it, so nothing
 * reaches here by accident any more.
 */
export function anthropic(): Anthropic {
  if (process.env.PAID_API !== "on") {
    throw new Error(
      "The paid Claude API is switched off (it bills ANTHROPIC_API_KEY). Set PAID_API=on in .env.local to allow it.",
    );
  }
  if (!client) client = new Anthropic({ apiKey: requireAnthropicKey() });
  return client;
}

export type { Anthropic };
