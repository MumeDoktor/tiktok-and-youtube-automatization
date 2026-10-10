import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

/**
 * The ambient motion-graphics layer.
 *
 * The word-triggered effects carry the story's impacts; these carry its
 * texture. Each one runs continuously or on its own clock rather than on a
 * spoken word, which is what separates "footage with captions" from something
 * that looks graded and produced. All are subtle by design - an effect you
 * consciously notice every time is a template tell, the same failure as one
 * transition used everywhere.
 */

/**
 * A warm light leak that drifts across the frame twice per video.
 *
 * Analogue light bleeding into old film stock is the single most recognisable
 * "graded footage" cue, and it costs nothing against the archive material
 * this pipeline cuts from. Screen blend keeps it additive over the picture.
 */
export const LightLeak: React.FC<{ seed: number }> = ({ seed }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  // Two passes per video, offset by the seed so clips do not sync up.
  const period = durationInFrames / 2;
  const phase = ((frame + seed * 90) % period) / period;
  // Ease so the leak swells in, drifts, and dies rather than sliding linearly.
  const strength = Math.sin(Math.PI * phase);
  const drift = interpolate(phase, [0, 1], [-30, 30]);

  return (
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(circle at calc(88% + " +
          drift +
          "%) 12%, rgba(255,190,110,0.55) 0%, rgba(255,140,60,0.22) 26%, rgba(0,0,0,0) 58%)",
        mixBlendMode: "screen",
        opacity: strength * 0.5,
        pointerEvents: "none",
      }}
    />
  );
};

/**
 * Cinematic vignette with a slow breathing edge.
 *
 * Dark corners pull the eye centre-ward, which is where vertical captions
 * live anyway. The breath is barely perceptible on purpose - static vignettes
 * read as a filter, moving ones read as optics.
 */
export const Vignette: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const breathe = Math.sin((frame / fps) * 0.6) * 0.03;

  return (
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(ellipse at center, rgba(0,0,0,0) 52%, rgba(0,0,0," +
          (0.42 + breathe).toFixed(3) +
          ") 100%)",
        pointerEvents: "none",
      }}
    />
  );
};

/**
 * An animated lower-third: slides in, holds, slides out.
 *
 * Documentary grammar the audience already knows how to read - a named thing,
 * anchored left, arriving after the hook has left. Text comes from the edit
 * itself (the film's title or the location), not invented by the model.
 */
export const LowerThird: React.FC<{
  text: string;
  sub?: string;
  accent: string;
  /** Seconds into the video it appears. */
  atSec: number;
  /** Seconds it stays up. */
  holdSec: number;
}> = ({ text, sub, accent, atSec, holdSec }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const startF = atSec * fps;
  const outF = startF + holdSec * fps;
  if (frame < startF || frame > outF + fps * 0.4) return null;

  // Slide + settle: overshoots slightly, springs back, exits downward-left.
  const enter = interpolate(frame, [startF, startF + fps * 0.5], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const exit = interpolate(frame, [outF, outF + fps * 0.4], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const x = -80 * (1 - enter) - 40 * exit;
  const opacity = Math.min(enter, 1 - exit);

  return (
    <div
      style={{
        position: "absolute",
        // Clear of the caption band when vertical; a normal lower third when wide.
        bottom: height > width ? 560 : 110,
        left: 70,
        opacity,
        transform: `translateX(${x}px)`,
        display: "flex",
        alignItems: "center",
        gap: 18,
        pointerEvents: "none",
      }}
    >
      <div style={{ width: 6, height: 84, background: accent }} />
      <div>
        <div
          style={{
            fontFamily: FONT,
            fontWeight: 800,
            fontSize: 46,
            color: "#FFFFFF",
            letterSpacing: -0.5,
            textShadow: "0 2px 18px rgba(0,0,0,0.8)",
          }}
        >
          {text}
        </div>
        {sub ? (
          <div
            style={{
              fontFamily: FONT,
              fontWeight: 600,
              fontSize: 28,
              color: "rgba(255,255,255,0.75)",
              marginTop: 4,
            }}
          >
            {sub}
          </div>
        ) : null}
      </div>
    </div>
  );
};

const FONT = "Plus Jakarta Sans";

/**
 * Speed-ramp transform for one violent moment.
 *
 * A hard cut to a launch or blast at constant speed reads as more archival
 * footage; the same moment slowed to 60% and released back reads as chosen.
 * Implemented as a time-remap curve over the shot's own span: fast at the
 * head, slow through the middle third, fast out. The picture never repeats -
 * it just lingers where the action is.
 *
 * Returns progress 0..1 within the source clip for a given timeline t, or
 * null when no ramp applies.
 */
export function rampProgress(t: number, ramp: boolean): number {
  if (!ramp) return t;
  // Slow zone sits across the middle: 0..0.25 fast, 0.25..0.65 slow, rest fast.
  const SLOW_START = 0.25;
  const SLOW_END = 0.65;
  const SLOW_FACTOR = 0.55;

  // Piecewise-linear remap of output progress to source progress.
  const totalWeight =
    SLOW_START + (SLOW_END - SLOW_START) / SLOW_FACTOR + (1 - SLOW_END);
  if (t <= SLOW_START) return t / totalWeight;
  if (t <= SLOW_END) {
    const consumed = SLOW_START / totalWeight;
    return consumed + (t - SLOW_START) / SLOW_FACTOR / totalWeight;
  }
  const consumed =
    SLOW_START / totalWeight + (SLOW_END - SLOW_START) / SLOW_FACTOR / totalWeight;
  return Math.min(1, consumed + (t - SLOW_END) / totalWeight);
}
