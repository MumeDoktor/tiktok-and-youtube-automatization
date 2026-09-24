import React from 'react';
import {interpolate, useCurrentFrame, useVideoConfig} from 'remotion';

/**
 * A location and date card that wipes in, holds, and leaves.
 *
 * It wipes rather than fades because a fade is what every template does; a
 * clip-path wipe behind a rule reads as a title someone cut.
 */
export const Stamp: React.FC<{text: string; atSec: number; accent: string}> = ({
	text,
	atSec,
	accent,
}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();

	const start = atSec * fps;
	const local = frame - start;
	const hold = fps * 2.6;
	if (local < 0 || local > hold) return null;

	const wipe = interpolate(local, [0, fps * 0.42], [0, 100], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
	});
	const out = interpolate(local, [hold - fps * 0.4, hold], [1, 0], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
	});

	return (
		<div
			style={{
				position: 'absolute',
				left: 56,
				bottom: 470,
				opacity: out,
				clipPath: `inset(0 ${100 - wipe}% 0 0)`,
			}}
		>
			<div
				style={{
					borderLeft: `5px solid ${accent}`,
					paddingLeft: 18,
					fontFamily: 'Plus Jakarta Sans, system-ui, sans-serif',
					fontSize: 30,
					fontWeight: 700,
					letterSpacing: 2.4,
					textTransform: 'uppercase',
					color: '#FFFFFF',
					textShadow: '0 2px 14px rgba(0,0,0,0.95)',
				}}
			>
				{text}
			</div>
		</div>
	);
};
