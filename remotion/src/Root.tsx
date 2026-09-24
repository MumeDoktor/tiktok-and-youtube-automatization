import React from "react";
import { Composition } from "remotion";
import { Clip } from "./Clip";
import type { ClipProps } from "./types";

const FPS = 30;

/**
 * One composition serves every clip: duration and props come from the render
 * command, so a new video never needs a rebuild.
 *
 * Length is taken from the narration rather than from summing the shots. The
 * voice is the spine of the edit - if the two ever disagree, the shots are
 * what is wrong.
 */
export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Clip"
      component={Clip}
      durationInFrames={30 * FPS}
      fps={FPS}
      width={1080}
      height={1920}
      defaultProps={
        {
          shots: [],
          words: [],
          lines: [],
          hookText: "Preview",
          musicVolume: 0.18,
          durationMs: 30_000,
          hits: [],
          look: {
            captions: "kinetic",
            hookExit: 2.2,
            accent: "#E0A526",
            grade: "archive",
            chrome: ["grain"],
            stamps: [],
          },
        } as ClipProps
      }
      calculateMetadata={({ props }) => {
        const p = props as ClipProps;
        const fromVoice = Math.round((p.durationMs / 1000) * FPS);
        const lastShot = p.shots.reduce((max, s) => Math.max(max, s.endMs), 0);
        // Guard against a shot list that runs past the narration; the tail
        // would otherwise be cut off mid-picture.
        const total = Math.max(fromVoice, Math.round((lastShot / 1000) * FPS));
        return { durationInFrames: Math.max(30, total) };
      }}
    />
  );
};
