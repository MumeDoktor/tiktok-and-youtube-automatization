import Anthropic from "@anthropic-ai/sdk";
import { requireAnthropicKey } from "./env";

let client: Anthropic | undefined;

export function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: requireAnthropicKey() });
  return client;
}

export type { Anthropic };
