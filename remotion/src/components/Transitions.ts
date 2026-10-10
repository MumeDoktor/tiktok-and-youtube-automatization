import { interpolate } from "remotion";
import type { Transition } from "../types";

/**
 * How an incoming shot arrives over the one it replaces.
 *
 * Both shots are on screen during the overlap - the incoming one is simply
 * drawn on top - so a transition is nothing more than a style applied to the
 * top layer as it takes over, plus an optional flare above both.
 *
 * `p` runs 0 to 1 across the overlap.
 */

export type IncomingStyle = {
  opacity: number;
  transform: string;
  filter: string;
};

/**
 * Ease-out cubic: fast away, slow to settle. Right for a move that has
 * momentum behind it - a whip, a zoom - because that is how a real one decays.
 */
function ease(p: number): number {
  return 1 - Math.pow(1 - p, 3);
}

/**
 * Smoothstep: slow at both ends, quickest through the middle.
 *
 * This is the curve for a blend. Ease-out makes a dissolve jump most of the
 * way in the first few frames and then crawl, which is exactly what reads as
 * abrupt even though the transition is nominally half a second long.
 */
function blend(p: number): number {
  return p * p * (3 - 2 * p);
}

/**
 * Ease-out quadratic: the same shape as ease() but far less front-loaded.
 *
 * Cubic is too aggressive for a short move. At the halfway point it has
 * already travelled 87% of the distance, so a 260ms whip is effectively over
 * in two frames and arrives as a hard cut with a smear on it. Quadratic is at
 * 75% instead, which leaves something on screen long enough to read as motion
 * while still decelerating the way a real camera move does.
 */
function easeSoft(p: number): number {
  return 1 - Math.pow(1 - p, 2);
}

export function incomingStyle(transition: Transition, p: number): IncomingStyle {
  const e = ease(p);

  switch (transition) {
    case "dissolve":
      return { opacity: blend(p), transform: "none", filter: "none" };

    case "glide":
      // The incoming shot settles back from a slight push while it fades up.
      // This is the smoothest of the set and the safest default.
      return {
        opacity: blend(p),
        transform: `scale(${interpolate(e, [0, 1], [1.08, 1])})`,
        filter: `blur(${interpolate(blend(p), [0, 1], [6, 0])}px)`,
      };

    case "whipL":
    case "whipR": {
      const from = transition === "whipL" ? 55 : -55;
      const w = easeSoft(p);
      return {
        // Opacity comes up fast so the swipe reads as movement, not a fade.
        opacity: interpolate(p, [0, 0.35], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        }),
        transform: `translateX(${interpolate(w, [0, 1], [from, 0])}%) scale(1.12)`,
        filter: `blur(${interpolate(w, [0, 1], [18, 0])}px)`,
      };
    }

    case "zoomBlur":
      return {
        opacity: interpolate(p, [0, 0.4], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        }),
        transform: `scale(${interpolate(easeSoft(p), [0, 1], [1.55, 1])})`,
        filter: `blur(${interpolate(easeSoft(p), [0, 1], [22, 0])}px)`,
      };

    case "flash":
    case "dipToBlack":
      // The flare below hides the swap, so the picture underneath it can
      // change instantly at the midpoint.
      return { opacity: p < 0.5 ? 0 : 1, transform: "none", filter: "none" };

    default:
      return { opacity: 1, transform: "none", filter: "none" };
  }
}

/**
 * The full-frame flare drawn above both shots, for transitions that work by
 * blinding the viewer for a few frames rather than by blending.
 */
export function flareStyle(
  transition: Transition,
  p: number,
): { background: string; opacity: number } | null {
  if (transition !== "flash" && transition !== "dipToBlack") return null;

  // Peaks at the midpoint, which is where the picture underneath changes.
  const opacity = interpolate(p, [0, 0.5, 1], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return {
    background: transition === "flash" ? "#FFFFFF" : "#000000",
    opacity,
  };
}

/** Hard cuts have no overlap, so nothing needs to be held over for them. */
export function isInstant(transition: Transition): boolean {
  return transition === "cut";
}
