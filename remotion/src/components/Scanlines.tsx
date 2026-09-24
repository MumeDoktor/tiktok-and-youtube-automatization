import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';

/**
 * Telecine scanlines with a slow roll.
 *
 * The roll is what sells it - static lines look like a CSS gradient, which is
 * what they are. Two pixels of drift per second is enough.
 */
export const Scanlines: React.FC = () => {
	const frame = useCurrentFrame();
	const offset = interpolate(frame % 120, [0, 120], [0, 6]);

	return (
		<AbsoluteFill
			style={{
				pointerEvents: 'none',
				opacity: 0.22,
				backgroundImage:
					'repeating-linear-gradient(180deg, rgba(0,0,0,0.55) 0px, rgba(0,0,0,0.55) 1px, rgba(0,0,0,0) 2px, rgba(0,0,0,0) 4px)',
				backgroundPosition: `0px ${offset}px`,
			}}
		/>
	);
};
