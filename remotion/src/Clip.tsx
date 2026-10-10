import React from "react";
import {
  AbsoluteFill,
  Audio,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Captions } from "./components/Captions";
import { EffectOverlays, hasMotion, pictureTransform } from "./components/Effects";
import { Grain } from "./components/Grain";
import { LightLeak, LowerThird, Vignette, rampProgress } from "./components/Motion";
import { Scanlines } from "./components/Scanlines";
import { Stamp } from "./components/Stamp";
import { Timecode } from "./components/Timecode";
import { flareStyle, incomingStyle } from "./components/Transitions";
import { colors, FONT_FAMILY } from "./theme";
import type { ClipProps, Grade, Move, Shot, TimedHit, Word } from "./types";
import "./fonts";

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
  steps.push("0 6px 24px rgba(0,0,0,0.6)");
  return steps.join(", ");
}

const GRADES: Record<Grade, string> = {
  archive: "sepia(0.20) saturate(1.18) contrast(1.09) brightness(1.05)",
  cold: "saturate(0.82) contrast(1.14) brightness(0.97) hue-rotate(-8deg)",
  warm: "sepia(0.10) saturate(1.22) contrast(1.05) brightness(1.04)",
  none: "none",
};

/**
 * The camera move for one shot.
 *
 * Every shot getting the same slow push is what made the old clips read as a
 * slideshow, so the move is a per-shot decision and `hold` still carries a
 * little drift - a completely locked frame looks like a dropped render.
 */
function transformFor(move: Move, t: number, pop: number): string {
  switch (move) {
    case "push":
      return `scale(${interpolate(t, [0, 1], [1.04, 1.19])})`;
    case "pull":
      return `scale(${interpolate(t, [0, 1], [1.22, 1.05])})`;
    case "driftL":
      return `scale(1.16) translateX(${interpolate(t, [0, 1], [3.2, -3.2])}%)`;
    case "driftR":
      return `scale(1.16) translateX(${interpolate(t, [0, 1], [-3.2, 3.2])}%)`;
    case "hold":
      return `scale(${interpolate(t, [0, 1], [1.03, 1.06])})`;
    case "punch":
      // Snaps in on a spring, then keeps creeping. Reserved for the payoff.
      return `scale(${interpolate(pop, [0, 1], [1.42, 1.12]) + t * 0.05})`;
    default:
      return "scale(1.05)";
  }
}

const ShotLayer: React.FC<{
  shot: Shot;
  durationInFrames: number;
  /** Frames of overlap at the head, during which the shot below is still up. */
  enterFrames: number;
  grade: Grade;
  /** Lingers through this shot's middle third - for violent moments. */
  ramp?: boolean;
}> = ({ shot, durationInFrames, enterFrames, grade, ramp }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // The camera move is measured from where the shot properly begins, not from
  // the start of its transition, so an overlap never eats into the move.
  const body = Math.max(1, durationInFrames - enterFrames);
  const rawT = Math.min(1, Math.max(0, (frame - enterFrames) / body));
  // Speed ramp: remap timeline progress into source progress so the shot
  // slows through its middle and releases. The camera move follows the same
  // clock, so picture and motion stay locked together.
  const t = ramp ? rampProgress(rawT, true) : rawT;
  const pop = spring({
    fps,
    frame: Math.max(0, frame - enterFrames),
    config: { damping: 18, mass: 0.5 },
  });

  const p = enterFrames > 0 ? Math.min(1, frame / enterFrames) : 1;
  const entry = incomingStyle(shot.transition, p);
  const flare = frame <= enterFrames ? flareStyle(shot.transition, p) : null;

  return (
    <>
      <AbsoluteFill
        style={{
          overflow: "hidden",
          opacity: entry.opacity,
          transform: entry.transform,
          filter: [GRADES[grade] ?? "none", entry.filter]
            .filter((f) => f && f !== "none")
            .join(" "),
        }}
      >
        <OffthreadVideo
          src={staticFile(shot.file)}
          // The narration is the audio bed; source audio under it would fight.
          muted
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform: transformFor(shot.move, t, pop),
          }}
        />
      </AbsoluteFill>
      {flare && (
        <AbsoluteFill style={{ background: flare.background, opacity: flare.opacity }} />
      )}
    </>
  );
};

/** Slams in, holds, and leaves. The leaving is the point. */
const Hook: React.FC<{ text: string; exitSec: number }> = ({ text, exitSec }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enter = spring({ fps, frame, config: { damping: 15, mass: 0.6 } });
  const exitStart = exitSec * fps;
  const out = interpolate(frame, [exitStart, exitStart + fps * 0.32], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  if (out <= 0) return null;

  return (
    <div
      style={{
        position: "absolute",
        top: 210,
        left: 60,
        right: 60,
        textAlign: "center",
        opacity: out * interpolate(enter, [0, 0.4], [0, 1], { extrapolateRight: "clamp" }),
        transform: `translateY(${interpolate(enter, [0, 1], [40, 0])}px) scale(${interpolate(
          enter,
          [0, 1],
          [1.12, 1],
        )})`,
      }}
    >
      <div
        style={{
          fontFamily: FONT_FAMILY,
          fontSize: text.length > 52 ? 62 : 74,
          fontWeight: 800,
          lineHeight: 1.05,
          letterSpacing: -1,
          color: colors.white,
          textShadow: outline(5),
        }}
      >
        {text}
      </div>
    </div>
  );
};

/** One whole line at a time, for footage that should not compete with motion. */
const BlockCaptions: React.FC<{ lines: ClipProps["lines"]; accent: string }> = ({
  lines,
  accent,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const nowMs = (frame / fps) * 1000;

  const current = lines.find((l) => nowMs >= l.startMs && nowMs < l.endMs);
  if (!current) return null;

  const age = (nowMs - current.startMs) / 1000;
  const opacity = interpolate(age, [0, 0.18], [0, 1], { extrapolateRight: "clamp" });

  return (
    <div
      style={{
        position: "absolute",
        bottom: 320,
        left: 76,
        right: 76,
        textAlign: "center",
        opacity,
        fontFamily: FONT_FAMILY,
        fontWeight: 800,
        fontSize: 54,
        lineHeight: 1.14,
        color: colors.white,
        textShadow: outline(4),
        borderBottom: `4px solid ${accent}`,
        paddingBottom: 16,
      }}
    >
      {current.text}
    </div>
  );
};

/**
 * Moves the picture for any effect that acts on the camera.
 *
 * Wraps the whole shot stack rather than a single shot, so a shake started on
 * one side of a cut carries through it - which is what a real camera knock
 * would do, and what stops the effect reading as a per-clip filter.
 */
const PictureEffects: React.FC<{ hits: TimedHit[]; children: React.ReactNode }> = ({
  hits,
  children,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const nowMs = (frame / fps) * 1000;
  const moving = hasMotion(hits, nowMs);

  return (
    <AbsoluteFill
      style={{
        transform: pictureTransform(hits, nowMs, frame),
        willChange: moving ? "transform" : undefined,
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

export const Clip: React.FC<ClipProps> = ({
  shots,
  words,
  lines,
  hookText,
  voiceFile,
  musicFile,
  musicVolume,
  hits,
  sfx,
  look,
}) => {
  const { fps } = useVideoConfig();
  const chrome = new Set(look.chrome ?? []);

  return (
    <AbsoluteFill style={{ backgroundColor: colors.bgDeep }}>
      {/* Each shot is drawn over the one before it. A shot with a transition
          starts early by the length of that transition and the shot beneath is
          held open underneath it, so the overlap is where the blend happens.
          The mix of transitions is chosen per clip - one transition used
          everywhere reads as generated whether it is a dissolve or a cut. */}
      <PictureEffects hits={hits ?? []}>
      {shots.map((shot, i) => {
        const start = Math.round((shot.startMs / 1000) * fps);
        const end = Math.round((shot.endMs / 1000) * fps);
        const enter = Math.round((shot.transitionMs / 1000) * fps);
        const next = shots[i + 1];
        // Hold this shot open under the next one while that one fades in.
        const hold = next ? Math.round((next.transitionMs / 1000) * fps) : 0;

        const from = Math.max(0, start - enter);
        const durationInFrames = Math.max(2, end + hold - from);

        return (
          <Sequence key={i} from={from} durationInFrames={durationInFrames}>
            <ShotLayer
              shot={shot}
              durationInFrames={durationInFrames}
              enterFrames={start - from}
              grade={look.grade}
              ramp={look.motion?.speedRamp === true && shot.move === "punch"}
            />
          </Sequence>
        );
      })}
      </PictureEffects>

      {chrome.has("scanlines") && <Scanlines />}
      {chrome.has("grain") && <Grain />}

      {/* Ambient motion layer: graded-footage cues that run continuously.
          Defaults on when the manifest does not name them - an absent choice
          is a choice, and the archive look wants both. */}
      {look.motion?.vignette !== false && <Vignette />}
      {look.motion?.lightLeak !== false && (
        <LightLeak seed={look.accent.length + shots.length} />
      )}
      {look.motion?.lowerThird ? (
        <LowerThird
          text={look.motion.lowerThird.text}
          sub={look.motion.lowerThird.sub}
          accent={look.accent}
          atSec={look.motion.lowerThird.atSec}
          holdSec={look.motion.lowerThird.holdSec}
        />
      ) : null}

      {/* Only as much scrim as the text actually needs. */}
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(180deg, rgba(0,0,0,0.60) 0%, rgba(0,0,0,0.10) 20%, rgba(0,0,0,0) 42%, rgba(0,0,0,0.28) 74%, rgba(0,0,0,0.72) 100%)",
        }}
      />

      {chrome.has("timecode") && <Timecode accent={look.accent} />}
      {chrome.has("stamp") &&
        (look.stamps ?? []).map((s, i) => (
          <Stamp key={i} text={s.text} atSec={s.atSec} accent={look.accent} />
        ))}

      {hookText ? <Hook text={hookText} exitSec={look.hookExit} /> : null}

      {look.captions === "kinetic" && words.length > 0 && (
        <Captions words={words} accent={look.accent} />
      )}
      {look.captions === "block" && lines.length > 0 && (
        <BlockCaptions lines={lines} accent={look.accent} />
      )}

      <EffectOverlays hits={hits ?? []} accent={look.accent} />

      {voiceFile ? <Audio src={staticFile(voiceFile)} /> : null}
      {musicFile ? <Audio src={staticFile(musicFile)} volume={musicVolume} loop /> : null}

      {/* Sound sits on the cuts and on the moments the story earned. Each one
          is its own sequence so it starts where it belongs and stops on its
          own; nothing here touches the speech already inside the footage. */}
      {(sfx ?? []).map((s, i) => (
        <Sequence key={`sfx-${i}`} from={Math.max(0, Math.round((s.atMs / 1000) * fps))}>
          <Audio src={staticFile(s.file)} volume={s.gain} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
