"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Bot, CornerDownLeft, Loader2, User } from "lucide-react";
import { Markdown } from "./markdown";

export type ChatTurn = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
};

/** Roughly four lines: enough that a short brief is visible without scrolling. */
const MIN_INPUT_PX = 92;
/** Around twelve lines, after which the box scrolls rather than eating the thread. */
const MAX_INPUT_PX = 300;

export function AgentChat({
  accountId,
  agentName,
  initialMessages,
}: {
  accountId: string;
  agentName: string;
  initialMessages: ChatTurn[];
}) {
  const router = useRouter();
  const [turns, setTurns] = useState<ChatTurn[]>(initialMessages);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  // Grow the box to fit what is in it.
  //
  // A textarea does not do this on its own: left alone it stays one row tall
  // and scrolls internally, so a pasted multi-line brief - which is how you
  // actually talk to the agent - arrives as a single cramped line you cannot
  // read back before sending.
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    // Collapse first, or scrollHeight only ever reports the current height and
    // the box can grow but never shrink.
    el.style.height = "0px";
    el.style.height = `${Math.min(MAX_INPUT_PX, Math.max(MIN_INPUT_PX, el.scrollHeight))}px`;
  }, [input]);

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;

    setError(null);
    setInput("");
    setStreaming(true);

    const userTurn: ChatTurn = {
      id: `u-${Date.now()}`,
      role: "user",
      content: text,
      createdAt: Date.now(),
    };
    const assistantId = `a-${Date.now()}`;
    setTurns((prev) => [
      ...prev,
      userTurn,
      { id: assistantId, role: "assistant", content: "", createdAt: Date.now() },
    ]);

    try {
      const res = await fetch(`/api/chat/${accountId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });

      if (!res.ok || !res.body) {
        throw new Error((await res.text()) || `Request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setTurns((prev) =>
          prev.map((t) => (t.id === assistantId ? { ...t, content: acc } : t)),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setTurns((prev) => prev.filter((t) => t.id !== assistantId));
    } finally {
      setStreaming(false);
      textRef.current?.focus();
      // A reply can queue a video. Refreshing pulls the new clip into the list,
      // which then keeps itself up to date while the video is being made.
      router.refresh();
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="flex h-[min(78vh,860px)] min-h-[560px] flex-col">
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {turns.length === 0 && (
          <div className="mt-16 text-center">
            <Bot className="mx-auto h-8 w-8 text-ink-3" />
            <p className="mt-3 text-sm font-medium text-ink-2">
              Talk to {agentName}
            </p>
            <p className="mx-auto mt-1 max-w-sm text-xs text-ink-3">
              {agentName} knows this account only: its numbers, its posts, its content
              rules. Anything you settle here is remembered and applied to every future
              post.
            </p>
          </div>
        )}

        {turns.map((turn) => (
          <div key={turn.id} className="fade-up flex gap-3">
            <div
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
                turn.role === "user" ? "bg-surface-3" : "bg-series-1/15"
              }`}
            >
              {turn.role === "user" ? (
                <User className="h-3 w-3 text-ink-2" />
              ) : (
                <Bot className="h-3 w-3 text-series-1" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="mb-1 text-[11px] font-medium text-ink-3">
                {turn.role === "user" ? "You" : agentName}
              </div>
              <div className="text-sm leading-relaxed text-ink-2">
                {turn.role === "assistant" ? (
                  <Markdown content={turn.content} />
                ) : (
                  <div className="whitespace-pre-wrap">{turn.content}</div>
                )}
                {streaming &&
                  turn.role === "assistant" &&
                  turn.id === turns[turns.length - 1]?.id &&
                  turn.content === "" && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-3" />
                  )}
              </div>
            </div>
          </div>
        ))}

        {error && (
          <div className="rounded-md border border-critical/30 bg-critical/10 px-3 py-2 text-xs text-critical">
            {error}
          </div>
        )}
      </div>

      <div className="border-t border-border p-3">
        <div className="rounded-xl border border-border bg-surface-2 px-3.5 py-3 transition-colors focus-within:border-border-strong">
          <textarea
            ref={textRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={`Message ${agentName}...`}
            disabled={streaming}
            style={{ height: MIN_INPUT_PX }}
            className="block w-full resize-none overflow-y-auto bg-transparent text-sm leading-relaxed outline-none placeholder:text-ink-3 disabled:opacity-50"
          />
          <div className="mt-2 flex items-center justify-between gap-3 border-t border-border/60 pt-2">
            <p className="text-[10px] text-ink-3">
              Enter to send &middot; Shift+Enter for a new line
            </p>
            <button
              onClick={() => void send()}
              disabled={streaming || !input.trim()}
              className="flex h-8 items-center gap-1.5 rounded-md bg-series-1 px-3 text-xs font-medium text-white transition disabled:opacity-30"
              aria-label="Send message"
            >
              {streaming ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Thinking
                </>
              ) : (
                <>
                  Send
                  <CornerDownLeft className="h-3.5 w-3.5" />
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
