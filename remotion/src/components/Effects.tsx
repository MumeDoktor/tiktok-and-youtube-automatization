import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { Effect, TimedHit } from "../types";

/**
 * Effects fired on individual spoken words.
 *
 * The distinction that matters: animating the letters is decoration, because
 * it happens on every word whether or not the word means anything. An effect
 * tied to one word fires rarely and only when the story earned it, so it reads
 * as emphasis rather than as a template.
 *
 * Split in two because they act on different layers. Transforms move the
 * picture and have to wrap the shot stack so they survive a cut; overlays are
 * drawn above everything including the captions.
 */

/** How long each effect runs, in ms. Tuned so each reads as what it is. */
const DURATION: Record<Effect, number> = {
  shake: 520,
  flash: 190,
  shockwave: 900,
  punch: 430,
  rumble: 1400,
  burn: 760,
  glitch: 320,
  drop: 540,
};

/** Progress 0..1 through a hit, or null when it is not running. */
function progress(hit: TimedHit, nowMs: number): number | null {
  const since = nowMs - hit.atMs;
  const span = DURATION[hit.effect];
  if (since < 0 || since > span) return null;
  return since / span;
}

/** Deterministic -1..1, so a shake is identical on every re-render. */
function noise(seed: number): number {
  const x = Math.sin(seed * 91.7351) * 47281.53;
  return (x - Math.floor(x)) * 2 - 1;
}

/**
 * The transform applied to the whole picture.
 *
 * Combined rather than last-wins: two effects on nearby words should compound
 * into one bigger movement, which is what would actually happen if a camera
 * were being hit twice.
 */
export function pictureTransform(hits: TimedHit[], nowMs: number, frame: number): string {
  let x = 0;
  let y = 0;
  let scale = 1;

  for (const hit of hits) {
    const p = progress(hit, nowMs);
    if (p === null) continue;
    const k = Math.max(0, Math.min(1, hit.intensity));

    switch (hit.effect) {
      case "shake": {
        // Squared decay: violent at the impact, gone almost immediately.
        const a = 26 * k * (1 - p) * (1 - p);
        x += noise(frame * 1.7) * a;
        y += noise(frame * 2.3 + 11) * a;
        break;
      }
      case "rumble": {
        // Low amplitude, long, and mostly vertical - an engine, not a punch.
        const a = 5 * k * (1 - p);
        y += Math.sin(frame * 1.1) * a;
        x += Math.sin(frame * 0.7) * a * 0.4;
        break;
      }
      case "punch":
        scale += 0.17 * k * Math.pow(1 - p, 3);
        break;
      case "drop":
        // Dips and recovers rather than falling away.
        y += 52 * k * Math.sin(Math.PI * p);
        break;
      default:
        break;
    }
  }

  // Always slightly overscanned so a shake never exposes the edge of frame.
  return `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${(scale * 1.06).toFixed(4)})`;
}

/** True when any transform-type effect is running, for willChange. */
export function hasMotion(hits: TimedHit[], nowMs: number): boolean {
  return hits.some((h) => progress(h, nowMs) !== null);
}

/**
 * Full-frame overlays: the effects that work by adding light or breaking the
 * image rather than by moving it.
 */
export const EffectOverlays: React.FC<{ hits: TimedHit[]; accent: string }> = ({
  hits,
  accent,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const nowMs = (frame / fps) * 1000;

  return (
    <>
      {hits.map((hit, i) => {
        const p = progress(hit, nowMs);
        if (p === null) return null;
        const k = Math.max(0, Math.min(1, hit.intensity));

        switch (hit.effect) {
          case "flash":
            return (
              <AbsoluteFill
                key={i}
                style={{
                  background: "#FFFFFF",
                  // Instant on, quick off. A flash that fades up is a dissolve.
                  opacity: k * Math.pow(1 - p, 1.6),
                  pointerEvents: "none",
                }}
              />
            );

          case "shockwave": {
            // Expands past the frame and thins as it goes.
            const size = 8 + p * 190;
            return (
              <AbsoluteFill
                key={i}
                style={{ alignItems: "center", justifyContent: "center", pointerEvents: "none" }}
              >
                <div
                  style={{
                    width: `${size}%`,
                    aspectRatio: "1 / 1",
                    borderRadius: "50%",
                    border: `${Math.max(1, 14 * (1 - p))}px solid ${accent}`,
                    opacity: k * (1 - p) * 0.85,
                    boxShadow: `0 0 ${60 * (1 - p)}px ${accent}`,
                  }}
                />
              </AbsoluteFill>
            );
          }

          case "burn": {
            // Warm light bleeding in from one corner, peaking mid-effect.
            const strength = Math.sin(Math.PI * p) * k;
            return (
              <AbsoluteFill
                key={i}
                style={{
                  background:
                    "radial-gradient(circle at 82% 18%, rgba(255,168,60,0.95) 0%, rgba(255,110,20,0.45) 28%, rgba(0,0,0,0) 62%)",
                  mixBlendMode: "screen",
                  opacity: strength * 0.9,
                  pointerEvents: "none",
                }}
              />
            );
          }

          case "glitch": {
            // Channel split, approximated with two offset tints rather than
            // three real channel copies - far cheaper and reads the same at
            // the speed this runs.
            const off = 16 * k * (1 - p);
            return (
              <React.Fragment key={i}>
                <AbsoluteFill
                  style={{
                    background: "rgba(255,0,60,0.30)",
                    mixBlendMode: "screen",
                    transform: `translateX(${off}px)`,
                    opacity: k * (1 - p),
                    pointerEvents: "none",
                  }}
                />
                <AbsoluteFill
                  style={{
                    background: "rgba(0,200,255,0.30)",
                    mixBlendMode: "screen",
                    transform: `translateX(${-off}px)`,
                    opacity: k * (1 - p),
                    pointerEvents: "none",
                  }}
                />
              </React.Fragment>
            );
          }

          default:
            return null;
        }
      })}
    </>
  );
};
