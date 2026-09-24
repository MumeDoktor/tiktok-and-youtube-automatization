import React from 'react';
import {AbsoluteFill, useCurrentFrame} from 'remotion';

/**
 * Film grain.
 *
 * The turbulence is rendered into one small tile and repeated rather than
 * generated at full frame size: a 1080x1920 feTurbulence per frame is slow
 * enough to dominate the render, and at this opacity nobody can tell.
 *
 * The seed steps every third frame. Changing it every frame reads as digital
 * static; holding it still reads as a dirty lens.
 */
export const Grain: React.FC<{opacity?: number}> = ({opacity = 0.16}) => {
	const frame = useCurrentFrame();
	const seed = Math.floor(frame / 3) % 12;

	return (
		<AbsoluteFill
			style={{
				opacity,
				mixBlendMode: 'overlay',
				pointerEvents: 'none',
			}}
		>
			<svg width="100%" height="100%">
				<filter id={`grain-${seed}`} x="0" y="0" width="100%" height="100%">
					<feTurbulence
						type="fractalNoise"
						baseFrequency="0.8"
						numOctaves={3}
						seed={seed}
						stitchTiles="stitch"
					/>
					<feColorMatrix type="saturate" values="0" />
				</filter>
				<rect width="100%" height="100%" filter={`url(#grain-${seed})`} />
			</svg>
		</AbsoluteFill>
	);
};
