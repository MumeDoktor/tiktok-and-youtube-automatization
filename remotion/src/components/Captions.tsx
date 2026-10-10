import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import type { Word } from "../types";
import { FONT_FAMILY } from "../theme";

/**
 * Word-by-word captions, deliberately still.
 *
 * An earlier version sprang, tilted and squashed every word as it arrived.
 * That is decoration: it happens identically whether the word is "the" or
 * "bomb", so it stops carrying meaning within a few seconds and starts
 * competing with the footage for attention.
 *
 * The movement in this video comes from effects fired on words that earned
 * them. These just have to be readable and land on the beat.
 */

/**
 * A stroke behind the glyphs rather than a drop shadow: text sits over
 * unpredictable footage, and only an outline stays legible on both a white
 * sky and a black hangar.
 */
function outline(width: number): string {
  const steps: string[] = [];
  for (let angle = 0; angle < 360; angle += 30) {
    const x = Math.round(Math.cos((angle * Math.PI) / 180) * width);
    const y = Math.round(Math.sin((angle * Math.PI) / 180) * width);
    steps.push(`${x}px ${y}px 0 #000`);
  }
  steps.push("0 6px 24px rgba(0,0,0,0.65)");
  return steps.join(", ");
}

export const Captions: React.FC<{ words: Word[]; accent: string }> = ({ words, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const nowMs = (frame / fps) * 1000;

  let active = -1;
  for (let i = 0; i < words.length; i++) {
    if (nowMs >= words[i].startMs && nowMs < words[i].endMs) {
      active = i;
      break;
    }
    // Hold the last word through the gap before the next one starts, so the
    // captions do not blink out between sentences.
    if (nowMs >= words[i].endMs && (i + 1 >= words.length || nowMs < words[i + 1].startMs)) {
      active = i;
    }
  }
  if (active === -1) return null;

  const line = words[active].line;
  const sameLine = words.filter((w) => w.line === line);
  const indexInLine = sameLine.indexOf(words[active]);
  const start = Math.max(0, Math.min(indexInLine - 1, sameLine.length - 3));
  const shown = sameLine.slice(start, start + 3);

  return (
    <div
      style={{
        position: "absolute",
        bottom: 330,
        left: 60,
        right: 60,
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        alignItems: "baseline",
        gap: "8px 18px",
      }}
    >
      {shown.map((w) => {
        const isActive = w === words[active];
        return (
          <span
            key={`${w.line}-${w.startMs}`}
            style={{
              fontFamily: FONT_FAMILY,
              fontWeight: 800,
              // Size and colour carry the emphasis. No transform at all: a
              // word that is simply there, on time, is what reads as calm.
              fontSize: isActive ? 70 : 56,
              lineHeight: 1,
              letterSpacing: -1,
              color: isActive ? accent : "#FFFFFF",
              textShadow: outline(4),
              opacity: isActive ? 1 : 0.78,
              display: "inline-block",
            }}
          >
            {w.text}
          </span>
        );
      })}
    </div>
  );
};
