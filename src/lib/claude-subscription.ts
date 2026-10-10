/** Structured Claude Code calls authenticated through the owner's subscription. */
import { spawn } from "node:child_process";
import type Anthropic from "@anthropic-ai/sdk";

type JsonSchema = Record<string, unknown>;

export function subscriptionEnv(): NodeJS.ProcessEnv {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_(OAUTH_TOKEN|USE_|API_KEY_HELPER|BARE)|CLAUDE_CONFIG_DIR$)/i.test(key)) {
      delete clean[key];
    }
  }
  delete clean.CLAUDECODE;
  return clean;
}

function runClaude(args: string[], input = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CLAUDE_CMD ?? "claude", args, {
      cwd: process.cwd(), env: subscriptionEnv(), windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    };
    const timer = setTimeout(() => {
      child.kill();
      fail("Claude subscription request timed out after 10 minutes");
    }, 600_000);
    child.stdout.on("data", (part: Buffer) => { stdout += part.toString(); });
    child.stderr.on("data", (part: Buffer) => { stderr = (stderr + part.toString()).slice(-3000); });
    child.on("error", (error) => { clearTimeout(timer); fail(`Claude Code could not start: ${error.message}`); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (code !== 0) return fail(`Claude subscription request failed (${code}): ${stderr || stdout.slice(-1500)}`);
      settled = true;
      resolve(stdout);
    });
    child.stdin.on("error", () => { /* close/error reports process failure */ });
    child.stdin.end(input);
  });
}

let authenticated: Promise<void> | undefined;
export async function requireSubscription(): Promise<void> {
  authenticated ??= (async () => {
    const status = JSON.parse(await runClaude(["auth", "status"])) as {
      loggedIn?: boolean; authMethod?: string; subscriptionType?: string;
    };
    if (!status.loggedIn || status.authMethod !== "claude.ai" || !status.subscriptionType) {
      throw new Error("Claude subscription login required; run claude auth login. Source selection will not fall back to the paid API.");
    }
  })().catch((error) => { authenticated = undefined; throw error; });
  return authenticated;
}

/** One schema-bound source decision. The CLI has no tools or filesystem access. */
export async function subscriptionDecision<T>(params: {
  system: string;
  prompt: string;
  schema: JsonSchema;
}): Promise<T> {
  await requireSubscription();
  const args = [
    "-p", "--model", "claude-opus-5-5", "--effort", "medium",
    "--output-format", "json", "--json-schema", JSON.stringify(params.schema),
    "--system-prompt", params.system,
    "--tools", "", "--safe-mode", "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--no-session-persistence", "--permission-mode", "dontAsk",
  ];
  const raw = await runClaude(args, params.prompt);
  const result = JSON.parse(raw) as {
    is_error?: boolean; subtype?: string; result?: string; structured_output?: T;
  };
  if (result.is_error || result.subtype !== "success") {
    throw new Error(`Claude subscription did not complete: ${result.result ?? result.subtype ?? "unknown error"}`);
  }
  if (result.structured_output === undefined) {
    throw new Error("Claude subscription returned no structured decision");
  }
  return result.structured_output;
}

/** Keep the existing single-tool decision call sites while changing transport. */
export async function subscriptionMessagesCreate(
  params: Anthropic.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Message> {
  const tool = params.tools?.[0];
  if (!tool || !("input_schema" in tool)) {
    throw new Error("A single schema-bound Claude decision tool is required");
  }
  const system = typeof params.system === "string"
    ? params.system
    : (params.system ?? []).map((block) => block.text).join("\n");
  const schema = tool.input_schema as JsonSchema;

  // Plain text goes as one prompt, as before.
  if (params.messages.every((m) => typeof m.content === "string")) {
    const prompt = params.messages.map((m) => m.content as string).join("\n\n");
    const input = await subscriptionDecision<unknown>({ system, prompt, schema });
    return { content: [{ type: "tool_use", id: "subscription", name: tool.name, input }] } as Anthropic.Message;
  }

  // Content blocks - frames to look at - go over stream-json, which carries
  // images the way the API does (the After Effects editor's verifier does the same).
  await requireSubscription();
  const effort = (params as { output_config?: { effort?: string } }).output_config?.effort ?? "medium";
  const args = [
    "-p", "--model", "claude-opus-5-5", "--effort", effort,
    "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--json-schema", JSON.stringify(schema),
    "--system-prompt", system,
    "--tools", "", "--safe-mode", "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--no-session-persistence", "--permission-mode", "dontAsk",
  ];
  const stdin = params.messages
    .map((message) => JSON.stringify({ type: "user", message: { role: "user", content: message.content } },
      // Claude Code owns caching; API cache markers can make a valid request fail.
      (key, value) => (key === "cache_control" ? undefined : value)))
    .join("\n") + "\n";
  const raw = await runClaude(args, stdin);
  const events = raw.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as {
    type?: string; is_error?: boolean; subtype?: string; result?: string; structured_output?: unknown;
  });
  const result = [...events].reverse().find((e) => e.type === "result");
  if (!result || result.is_error || result.subtype !== "success") {
    throw new Error(`Claude subscription did not complete: ${result?.result ?? result?.subtype ?? "no result"}`);
  }
  if (result.structured_output === undefined) throw new Error("Claude subscription returned no structured decision");
  return {
    content: [{ type: "tool_use", id: "subscription", name: tool.name, input: result.structured_output }],
  } as Anthropic.Message;
}
