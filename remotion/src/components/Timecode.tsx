import React from 'react';
import {useCurrentFrame, useVideoConfig} from 'remotion';

/** Frames as a two-digit field, the way a deck would show them. */
function pad(n: number, width = 2): string {
	return String(Math.floor(n)).padStart(width, '0');
}

/**
 * A running timecode burn with a blinking record dot.
 *
 * Deliberately monospaced and slightly transparent: it should read as
 * something the footage arrived with, not as an overlay that was added.
 */
export const Timecode: React.FC<{accent: string}> = ({accent}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();

	const totalSeconds = frame / fps;
	const hh = pad(totalSeconds / 3600);
	const mm = pad((totalSeconds / 60) % 60);
	const ss = pad(totalSeconds % 60);
	const ff = pad(frame % fps);

	// Roughly one blink a second.
	const on = frame % fps < fps * 0.6;

	return (
		<div
			style={{
				position: 'absolute',
				top: 64,
				left: 56,
				display: 'flex',
				alignItems: 'center',
				gap: 14,
				fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
				fontSize: 26,
				fontWeight: 600,
				letterSpacing: 1.5,
				color: 'rgba(255,255,255,0.82)',
				textShadow: '0 2px 8px rgba(0,0,0,0.9)',
			}}
		>
			<span
				style={{
					width: 13,
					height: 13,
					borderRadius: '50%',
					background: accent,
					opacity: on ? 1 : 0.15,
					boxShadow: `0 0 12px ${accent}`,
				}}
			/>
			{`${hh}:${mm}:${ss}:${ff}`}
		</div>
	);
};
