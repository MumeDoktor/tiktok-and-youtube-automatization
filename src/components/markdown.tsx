import React from "react";

/**
 * A very small Markdown renderer for chat replies.
 *
 * The model writes Markdown whether or not anyone asked it to, and the chat
 * pane was showing the raw asterisks. This covers what actually turns up in a
 * reply - emphasis, code, bullets, numbered steps, the occasional heading -
 * and deliberately nothing else.
 *
 * It builds React elements rather than HTML, so there is no
 * dangerouslySetInnerHTML and nothing the model writes can become markup.
 */

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "h"; level: number; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "hr" };

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    if (/^\s{0,3}(?:---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }

    const heading = /^\s{0,3}(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "h", level: heading[1].length, text: heading[2].trim() });
      i++;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }

    // A paragraph runs until a blank line or the start of another block.
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^\s{0,3}#{1,4}\s+/.test(lines[i])
    ) {
      paragraph.push(lines[i]);
      i++;
    }
    blocks.push({ kind: "p", lines: paragraph });
  }

  return blocks;
}

// Order matters: bold before italic, so ** is never read as two singles.
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|(?<![*\w])\*[^*\n]+\*(?!\*)|(?<![_\w])_[^_\n]+_(?![_\w]))/g;

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let n = 0;

  INLINE.lastIndex = 0;
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${n++}`;

    if (token.startsWith("**")) {
      out.push(
        <strong key={key} className="font-semibold text-ink-1">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("`")) {
      out.push(
        <code
          key={key}
          className="rounded bg-surface-3 px-1 py-0.5 font-mono text-[0.85em] text-ink-1"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      out.push(
        <em key={key} className="italic text-ink-3">
          {token.slice(1, -1)}
        </em>,
      );
    }
    last = match.index + token.length;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ content }: { content: string }) {
  const blocks = React.useMemo(() => parseBlocks(content), [content]);

  return (
    <div className="space-y-2.5 text-sm leading-relaxed text-ink-2">
      {blocks.map((block, i) => {
        switch (block.kind) {
          case "h":
            return (
              <div
                key={i}
                className={
                  block.level <= 2
                    ? "pt-1 text-[13px] font-semibold text-ink-1"
                    : "pt-0.5 text-xs font-semibold uppercase tracking-wide text-ink-3"
                }
              >
                {renderInline(block.text, `h${i}`)}
              </div>
            );

          case "hr":
            return <hr key={i} className="border-border" />;

          case "ul":
            return (
              <ul key={i} className="space-y-1">
                {block.items.map((item, k) => (
                  <li key={k} className="flex gap-2">
                    <span className="mt-[0.55em] h-1 w-1 shrink-0 rounded-full bg-ink-3" />
                    <span className="min-w-0">{renderInline(item, `u${i}-${k}`)}</span>
                  </li>
                ))}
              </ul>
            );

          case "ol":
            return (
              <ol key={i} className="space-y-1">
                {block.items.map((item, k) => (
                  <li key={k} className="flex gap-2">
                    <span className="shrink-0 text-xs font-medium tabular-nums text-ink-3">
                      {k + 1}.
                    </span>
                    <span className="min-w-0">{renderInline(item, `o${i}-${k}`)}</span>
                  </li>
                ))}
              </ol>
            );

          default:
            return (
              <p key={i} className="whitespace-pre-wrap">
                {block.lines.map((line, k) => (
                  <React.Fragment key={k}>
                    {k > 0 && "\n"}
                    {renderInline(line, `p${i}-${k}`)}
                  </React.Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}
