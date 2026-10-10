import React, { useMemo } from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { geoInterpolate, geoMercator, geoPath } from "d3-geo";
import { feature, mesh } from "topojson-client";
import world from "world-atlas/countries-50m.json";
import { FONT_FAMILY } from "./theme";
import "./fonts";

/**
 * A sourced story in a 16:9 frame: every picture is about the thing being
 * said. Photographs of the actual aircraft and place, a map of the actual
 * route, the words someone actually said with their name under them, the
 * number the narrator just spoke. Nothing here is generic footage.
 *
 * Mirrors the scene types in src/agent/long.ts. Keep the two in step.
 */

export type Place = { name: string; lat: number; lon: number };

export type StoryScene = {
  startMs: number;
  endMs: number;
  kind: "title" | "photo" | "map" | "quote" | "number" | "fact";
  /** photo: the picture. Any other kind: an optional dimmed backdrop. */
  file?: string;
  /** photo: what it shows. */
  caption?: string;
  credit?: string;
  /** title / fact / quote / number: the main text. */
  text?: string;
  /** title: second line. quote: who said it. number: what it counts. fact: the small line above. */
  sub?: string;
  /** quote: where the words are recorded. */
  source?: string;
  /** map */
  from?: Place;
  to?: Place;
  point?: Place;
  /** map: how far along the route the aircraft got (0-1). */
  progress?: number;
};

export type StoryProps = {
  scenes: StoryScene[];
  voiceFile?: string;
  durationMs: number;
  accent: string;
};

const BG = "#0B0E12";
const INK = "#EEF1F4";
const DIM = "rgba(238,241,244,0.58)";

const useEnter = (delayFrames = 0) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ fps, frame: Math.max(0, frame - delayFrames), config: { damping: 20, mass: 0.6 } });
};

/** A dimmed, blurred picture behind a card, so a card is never a flat slide. */
const Backdrop: React.FC<{ file?: string; frames: number }> = ({ file, frames }) => {
  const frame = useCurrentFrame();
  if (!file) {
    return (
      <AbsoluteFill
        style={{ background: `radial-gradient(120% 90% at 30% 20%, #1A222B 0%, ${BG} 62%)` }}
      />
    );
  }
  const scale = interpolate(frame, [0, frames], [1.12, 1.2]);
  return (
    <AbsoluteFill style={{ background: BG, overflow: "hidden" }}>
      <Img
        src={staticFile(file)}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${scale})`,
          filter: "blur(18px) saturate(0.75) brightness(0.42)",
        }}
      />
    </AbsoluteFill>
  );
};

const Photo: React.FC<{ scene: StoryScene; frames: number; index: number; accent: string }> = ({
  scene,
  frames,
  index,
  accent,
}) => {
  const frame = useCurrentFrame();
  const enter = useEnter(6);
  if (!scene.file) return null;
  // Alternate the move so two photographs in a row never drift the same way.
  const moves = [
    { s: [1.0, 1.08], x: [0, -18], y: [0, -8] },
    { s: [1.08, 1.0], x: [-14, 10], y: [0, 6] },
    { s: [1.02, 1.1], x: [14, -6], y: [6, -6] },
    { s: [1.09, 1.02], x: [6, 16], y: [-6, 4] },
  ][index % 4];
  const t = frames > 1 ? frame / frames : 0;
  const scale = moves.s[0] + (moves.s[1] - moves.s[0]) * t;
  const x = moves.x[0] + (moves.x[1] - moves.x[0]) * t;
  const y = moves.y[0] + (moves.y[1] - moves.y[0]) * t;
  return (
    <AbsoluteFill style={{ background: BG, overflow: "hidden" }}>
      {/* The same picture, blurred, fills what a 4:3 or portrait frame leaves empty. */}
      <Img
        src={staticFile(scene.file)}
        style={{
          position: "absolute",
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: "scale(1.15)",
          filter: "blur(28px) brightness(0.42) saturate(0.8)",
        }}
      />
      <Img
        src={staticFile(scene.file)}
        style={{
          position: "absolute",
          width: "100%",
          height: "100%",
          objectFit: "contain",
          transform: `scale(${scale}) translate(${x}px, ${y}px)`,
          filter: "contrast(1.04)",
        }}
      />
      <AbsoluteFill
        style={{ background: "linear-gradient(180deg, rgba(0,0,0,0) 62%, rgba(0,0,0,0.72) 100%)" }}
      />
      {scene.caption ? (
        <div
          style={{
            position: "absolute",
            left: 70,
            bottom: 74,
            maxWidth: 1300,
            opacity: enter,
            transform: `translateY(${(1 - enter) * 18}px)`,
            display: "flex",
            gap: 18,
            alignItems: "stretch",
          }}
        >
          <div style={{ width: 6, background: accent, borderRadius: 3 }} />
          <div
            style={{
              fontFamily: FONT_FAMILY,
              fontWeight: 700,
              fontSize: 36,
              lineHeight: 1.25,
              color: INK,
              textShadow: "0 2px 14px rgba(0,0,0,0.8)",
            }}
          >
            {scene.caption}
          </div>
        </div>
      ) : null}
      {scene.credit ? (
        <div
          style={{
            position: "absolute",
            right: 40,
            bottom: 26,
            fontFamily: FONT_FAMILY,
            fontWeight: 600,
            fontSize: 17,
            color: "rgba(255,255,255,0.5)",
          }}
        >
          {scene.credit}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

const Title: React.FC<{ scene: StoryScene; frames: number; accent: string }> = ({ scene, frames, accent }) => {
  const enter = useEnter(4);
  const line = useEnter(10);
  return (
    <AbsoluteFill>
      <Backdrop file={scene.file} frames={frames} />
      <AbsoluteFill style={{ justifyContent: "center", padding: "0 150px" }}>
        {scene.sub ? (
          <div
            style={{
              fontFamily: FONT_FAMILY,
              fontWeight: 700,
              fontSize: 30,
              letterSpacing: 6,
              textTransform: "uppercase",
              color: accent,
              opacity: enter,
              marginBottom: 26,
            }}
          >
            {scene.sub}
          </div>
        ) : null}
        <div
          style={{
            fontFamily: FONT_FAMILY,
            fontWeight: 800,
            fontSize: (scene.text ?? "").length > 34 ? 92 : 118,
            lineHeight: 1.04,
            color: INK,
            opacity: enter,
            transform: `translateY(${(1 - enter) * 30}px)`,
          }}
        >
          {scene.text}
        </div>
        <div style={{ height: 8, width: 260 * line, background: accent, marginTop: 40, borderRadius: 4 }} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const Quote: React.FC<{ scene: StoryScene; frames: number; accent: string }> = ({ scene, frames, accent }) => {
  const enter = useEnter(4);
  const who = useEnter(16);
  const text = scene.text ?? "";
  const size = text.length > 220 ? 46 : text.length > 130 ? 56 : text.length > 70 ? 68 : 82;
  return (
    <AbsoluteFill>
      <Backdrop file={scene.file} frames={frames} />
      <AbsoluteFill style={{ justifyContent: "center", padding: "0 190px" }}>
        <div
          style={{
            fontFamily: "Georgia, 'Times New Roman', serif",
            fontSize: 220,
            lineHeight: 0.6,
            color: accent,
            opacity: enter,
            height: 90,
          }}
        >
          &ldquo;
        </div>
        <div
          style={{
            fontFamily: FONT_FAMILY,
            fontWeight: 700,
            fontSize: size,
            lineHeight: 1.22,
            color: INK,
            opacity: enter,
            transform: `translateY(${(1 - enter) * 24}px)`,
          }}
        >
          {text}
        </div>
        <div style={{ marginTop: 44, opacity: who, display: "flex", alignItems: "center", gap: 20 }}>
          <div style={{ width: 54, height: 4, background: accent }} />
          <div>
            <div style={{ fontFamily: FONT_FAMILY, fontWeight: 800, fontSize: 34, color: INK }}>{scene.sub}</div>
            {scene.source ? (
              <div style={{ fontFamily: FONT_FAMILY, fontWeight: 600, fontSize: 24, color: DIM, marginTop: 4 }}>
                {scene.source}
              </div>
            ) : null}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const NumberCard: React.FC<{ scene: StoryScene; frames: number; accent: string }> = ({ scene, frames, accent }) => {
  const enter = useEnter(3);
  const label = useEnter(12);
  const text = scene.text ?? "";
  return (
    <AbsoluteFill>
      <Backdrop file={scene.file} frames={frames} />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <div
          style={{
            fontFamily: FONT_FAMILY,
            fontWeight: 800,
            fontSize: text.length > 9 ? 190 : text.length > 5 ? 260 : 340,
            lineHeight: 1,
            color: INK,
            letterSpacing: -4,
            transform: `scale(${0.86 + 0.14 * enter})`,
            opacity: enter,
          }}
        >
          {text}
        </div>
        <div style={{ width: 200 * label, height: 8, background: accent, borderRadius: 4, margin: "34px 0 30px" }} />
        <div
          style={{
            fontFamily: FONT_FAMILY,
            fontWeight: 700,
            fontSize: 44,
            color: DIM,
            opacity: label,
            textAlign: "center",
            maxWidth: 1400,
            letterSpacing: 1,
          }}
        >
          {scene.sub}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const Fact: React.FC<{ scene: StoryScene; frames: number; accent: string }> = ({ scene, frames, accent }) => {
  const enter = useEnter(4);
  const text = scene.text ?? "";
  return (
    <AbsoluteFill>
      <Backdrop file={scene.file} frames={frames} />
      <AbsoluteFill style={{ justifyContent: "center", padding: "0 170px" }}>
        <div
          style={{
            background: "rgba(20,26,33,0.86)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderLeft: `10px solid ${accent}`,
            borderRadius: 14,
            padding: "56px 64px",
            opacity: enter,
            transform: `translateX(${(1 - enter) * -40}px)`,
          }}
        >
          {scene.sub ? (
            <div
              style={{
                fontFamily: FONT_FAMILY,
                fontWeight: 800,
                fontSize: 34,
                letterSpacing: 5,
                textTransform: "uppercase",
                color: accent,
                marginBottom: 22,
              }}
            >
              {scene.sub}
            </div>
          ) : null}
          <div
            style={{
              fontFamily: FONT_FAMILY,
              fontWeight: 700,
              fontSize: text.length > 120 ? 54 : text.length > 60 ? 66 : 80,
              lineHeight: 1.18,
              color: INK,
            }}
          >
            {text}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/* -------------------------------------------------------------------- */
/* Map                                                                  */
/* -------------------------------------------------------------------- */

type Topology = Parameters<typeof feature>[0];
const topo = world as unknown as Topology & { objects: { countries: never; land: never } };
const LAND = feature(topo, topo.objects.land);
const BORDERS = mesh(topo, topo.objects.countries, (a, b) => a !== b);

const MapScene: React.FC<{ scene: StoryScene; frames: number; accent: string }> = ({ scene, frames, accent }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const enter = useEnter(2);

  const { landPath, borderPath, route, pts } = useMemo(() => {
    const places = [scene.from, scene.to, scene.point].filter((p): p is Place => Boolean(p));
    const projection = geoMercator();
    if (places.length >= 2) {
      const coords = places.map((p) => [p.lon, p.lat] as [number, number]);
      // Fit the places with room around them, then never closer than a region:
      // two airports forty miles apart would otherwise be a frame of open sea.
      projection.fitExtent(
        [
          [width * 0.24, height * 0.28],
          [width * 0.76, height * 0.72],
        ],
        { type: "MultiPoint", coordinates: coords } as never,
      );
      const scale = Math.min(projection.scale(), 6500);
      const lon = (Math.min(...coords.map((c) => c[0])) + Math.max(...coords.map((c) => c[0]))) / 2;
      const lat = (Math.min(...coords.map((c) => c[1])) + Math.max(...coords.map((c) => c[1]))) / 2;
      projection.scale(scale).center([lon, lat]).translate([width / 2, height / 2]);
    } else if (places.length === 1) {
      projection.center([places[0].lon, places[0].lat]).scale(2600).translate([width / 2, height / 2]);
    } else {
      projection.fitSize([width, height], LAND as never);
    }
    const path = geoPath(projection);
    let line: Array<[number, number]> = [];
    if (scene.from && scene.to) {
      const interp = geoInterpolate([scene.from.lon, scene.from.lat], [scene.to.lon, scene.to.lat]);
      line = Array.from({ length: 81 }, (_, i) => projection(interp(i / 80)) as [number, number]);
    }
    return {
      landPath: path(LAND as never) ?? "",
      borderPath: path(BORDERS as never) ?? "",
      route: line,
      pts: places.map((p) => ({ place: p, xy: projection([p.lon, p.lat]) as [number, number] })),
    };
  }, [scene, width, height]);

  const reach = Math.max(0.05, Math.min(1, scene.progress ?? 1));
  const drawn = interpolate(frame, [8, Math.max(20, frames * 0.6)], [0, reach], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const upto = Math.max(1, Math.round(drawn * (route.length - 1)));
  const flown = route.slice(0, upto + 1);
  const head = flown[flown.length - 1];
  const toPath = (line: Array<[number, number]>) => line.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
  const stopped = scene.progress !== undefined && scene.progress < 0.98 && drawn >= reach - 0.001;
  const pulse = 1 + 0.25 * Math.sin(frame / 5);

  return (
    <AbsoluteFill style={{ background: "#0A1016", opacity: enter }}>
      <svg width={width} height={height}>
        <path d={landPath} fill="#243340" stroke="rgba(255,255,255,0.16)" strokeWidth={1.5} />
        <path d={borderPath} fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth={1.2} />
        {route.length ? (
          <>
            <path d={toPath(route)} fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth={3} strokeDasharray="4 12" />
            <path d={toPath(flown)} fill="none" stroke={accent} strokeWidth={6} strokeLinecap="round" />
            {head ? (
              <>
                <circle cx={head[0]} cy={head[1]} r={stopped ? 22 * pulse : 12} fill="none" stroke={accent} strokeWidth={stopped ? 4 : 0} />
                <circle cx={head[0]} cy={head[1]} r={10} fill={INK} stroke={accent} strokeWidth={4} />
              </>
            ) : null}
          </>
        ) : null}
        {pts.map(({ place, xy }, i) => {
          const isPoint = scene.point && place === scene.point;
          const right = xy[0] < width * 0.7;
          return (
            <g key={i}>
              <circle cx={xy[0]} cy={xy[1]} r={isPoint ? 20 * pulse : 9} fill="none" stroke={accent} strokeWidth={isPoint ? 4 : 0} />
              <circle cx={xy[0]} cy={xy[1]} r={9} fill={isPoint ? accent : INK} />
              <text
                x={xy[0] + (right ? 24 : -24)}
                y={xy[1] - 20}
                textAnchor={right ? "start" : "end"}
                fontFamily={FONT_FAMILY}
                fontWeight={800}
                fontSize={36}
                fill={INK}
                stroke="#0A1016"
                strokeWidth={8}
                paintOrder="stroke"
              >
                {place.name}
              </text>
            </g>
          );
        })}
      </svg>
      {scene.caption ? (
        <div
          style={{
            position: "absolute",
            left: 70,
            bottom: 70,
            background: "rgba(20,26,33,0.9)",
            borderLeft: `8px solid ${accent}`,
            borderRadius: 10,
            padding: "22px 30px",
            fontFamily: FONT_FAMILY,
            fontWeight: 700,
            fontSize: 38,
            color: INK,
            maxWidth: 1200,
          }}
        >
          {scene.caption}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

export const Story: React.FC<StoryProps> = ({ scenes, voiceFile, accent }) => {
  const { fps } = useVideoConfig();
  let photoIndex = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: BG }}>
      {scenes.map((scene, i) => {
        const from = Math.round((scene.startMs / 1000) * fps);
        const frames = Math.max(2, Math.round(((scene.endMs - scene.startMs) / 1000) * fps));
        const body =
          scene.kind === "photo" ? (
            <Photo scene={scene} frames={frames} index={photoIndex++} accent={accent} />
          ) : scene.kind === "map" ? (
            <MapScene scene={scene} frames={frames} accent={accent} />
          ) : scene.kind === "quote" ? (
            <Quote scene={scene} frames={frames} accent={accent} />
          ) : scene.kind === "number" ? (
            <NumberCard scene={scene} frames={frames} accent={accent} />
          ) : scene.kind === "fact" ? (
            <Fact scene={scene} frames={frames} accent={accent} />
          ) : (
            <Title scene={scene} frames={frames} accent={accent} />
          );
        return (
          // Each scene runs a few frames past its end so the next can fade in over it.
          <Sequence key={i} from={from} durationInFrames={frames + 8}>
            <FadeIn skip={i === 0}>{body}</FadeIn>
          </Sequence>
        );
      })}
      {voiceFile ? <Audio src={staticFile(voiceFile)} /> : null}
    </AbsoluteFill>
  );
};

const FadeIn: React.FC<{ children: React.ReactNode; skip?: boolean }> = ({ children, skip }) => {
  const frame = useCurrentFrame();
  const opacity = skip ? 1 : interpolate(frame, [0, 8], [0, 1], { extrapolateRight: "clamp" });
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
};
