"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { compact, full } from "@/lib/format";

export type Point = { t: number; v: number };

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  return { ref, width };
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) return [min];
  const span = max - min;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 0.001; v += step) out.push(v);
  return out;
}

/** Catmull-Rom to cubic Bezier — a smooth line that still hits every point. */
function smoothPath(pts: Array<{ x: number; y: number }>): string {
  if (pts.length === 0) return "";
  if (pts.length < 3) {
    return pts.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ");
  }
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${c1x},${c1y} ${c2x},${c2y} ${p2.x},${p2.y}`;
  }
  return d;
}

/* ------------------------------------------------------------------ */
/* Sparkline — no axes, no hover, reads as a texture not a chart       */
/* ------------------------------------------------------------------ */

export function Sparkline({
  data,
  color = "var(--color-series-1)",
  height = 34,
}: {
  data: Point[];
  color?: string;
  height?: number;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();

  const path = useMemo(() => {
    if (!width || data.length < 2) return { line: "", area: "" };
    const pad = 2;
    const values = data.map((d) => d.v);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const pts = data.map((d, i) => ({
      x: pad + (i / (data.length - 1)) * (width - pad * 2),
      y: pad + (1 - (d.v - min) / span) * (height - pad * 2),
    }));
    const line = smoothPath(pts);
    return {
      line,
      area: `${line} L${pts[pts.length - 1].x},${height} L${pts[0].x},${height} Z`,
    };
  }, [data, width, height]);

  const gradId = useMemo(() => `spark-${Math.random().toString(36).slice(2, 8)}`, []);

  return (
    <div ref={ref} style={{ height }} className="w-full">
      {width > 0 && path.line && (
        <svg width={width} height={height} aria-hidden>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={path.area} fill={`url(#${gradId})`} />
          <path
            d={path.line}
            fill="none"
            stroke={color}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* LineChart — single series, crosshair + tooltip                      */
/* ------------------------------------------------------------------ */

export function LineChart({
  data,
  label,
  color = "var(--color-series-1)",
  height = 200,
}: {
  data: Point[];
  /** Names the series, so no legend box is needed for a single line. */
  label: string;
  color?: string;
  height?: number;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const M = { top: 12, right: 12, bottom: 24, left: 46 };

  const geom = useMemo(() => {
    if (!width || data.length < 2) return null;
    const iw = width - M.left - M.right;
    const ih = height - M.top - M.bottom;

    const values = data.map((d) => d.v);
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    // Headroom keeps the line off the frame edges.
    const pad = (rawMax - rawMin || rawMax || 1) * 0.12;
    const min = Math.max(0, rawMin - pad);
    const max = rawMax + pad;
    const span = max - min || 1;

    const x = (i: number) => M.left + (i / (data.length - 1)) * iw;
    const y = (v: number) => M.top + (1 - (v - min) / span) * ih;

    const pts = data.map((d, i) => ({ x: x(i), y: y(d.v) }));
    const line = smoothPath(pts);
    const area = `${line} L${pts[pts.length - 1].x},${M.top + ih} L${pts[0].x},${M.top + ih} Z`;

    return { iw, ih, min, max, x, y, pts, line, area, ticks: niceTicks(min, max, 4) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, width, height]);

  const gradId = useMemo(() => `line-${Math.random().toString(36).slice(2, 8)}`, []);

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    if (!geom) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const ratio = (px - M.left) / geom.iw;
    const idx = Math.round(ratio * (data.length - 1));
    setHover(Math.min(data.length - 1, Math.max(0, idx)));
  }

  const active = hover !== null ? data[hover] : null;

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {geom && (
        <>
          <svg
            width={width}
            height={height}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
            role="img"
            aria-label={`${label} over time`}
          >
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity="0.22" />
                <stop offset="100%" stopColor={color} stopOpacity="0" />
              </linearGradient>
            </defs>

            {/* Recessive gridlines */}
            {geom.ticks.map((t) => (
              <g key={t}>
                <line
                  x1={M.left}
                  x2={width - M.right}
                  y1={geom.y(t)}
                  y2={geom.y(t)}
                  stroke="var(--color-border)"
                  strokeWidth="1"
                />
                <text
                  x={M.left - 8}
                  y={geom.y(t)}
                  textAnchor="end"
                  dominantBaseline="middle"
                  fill="var(--color-ink-3)"
                  fontSize="10"
                  fontFamily="var(--font-mono)"
                >
                  {compact(t)}
                </text>
              </g>
            ))}

            <path d={geom.area} fill={`url(#${gradId})`} />
            <path
              d={geom.line}
              fill="none"
              stroke={color}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />

            {/* First / last date labels only — a date under every point is noise */}
            <text
              x={M.left}
              y={height - 6}
              fill="var(--color-ink-3)"
              fontSize="10"
              fontFamily="var(--font-mono)"
            >
              {new Date(data[0].t).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              })}
            </text>
            <text
              x={width - M.right}
              y={height - 6}
              textAnchor="end"
              fill="var(--color-ink-3)"
              fontSize="10"
              fontFamily="var(--font-mono)"
            >
              {new Date(data[data.length - 1].t).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              })}
            </text>

            {hover !== null && (
              <g pointerEvents="none">
                <line
                  x1={geom.x(hover)}
                  x2={geom.x(hover)}
                  y1={M.top}
                  y2={M.top + geom.ih}
                  stroke="var(--color-border-strong)"
                  strokeWidth="1"
                />
                {/* 2px surface ring separates the marker from the line */}
                <circle
                  cx={geom.x(hover)}
                  cy={geom.y(data[hover].v)}
                  r="5"
                  fill={color}
                  stroke="var(--color-surface-1)"
                  strokeWidth="2"
                />
              </g>
            )}
          </svg>

          {active && (
            <div
              className="pointer-events-none absolute z-10 rounded-md border border-border-strong bg-surface-2 px-2.5 py-1.5 text-xs shadow-lg"
              style={{
                left: Math.min(Math.max(geom.x(hover!) - 60, 0), Math.max(width - 130, 0)),
                top: 4,
              }}
            >
              <div className="font-mono text-[10px] text-ink-3">
                {new Date(active.t).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </div>
              <div className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: color }}
                />
                <span className="text-ink-2">{label}</span>
                <span className="ml-1 font-mono font-semibold text-ink">
                  {full(active.v)}
                </span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* BarList — per-post performance, ranked                              */
/* ------------------------------------------------------------------ */

export function BarList({
  items,
  color = "var(--color-series-1)",
  valueLabel = "views",
}: {
  items: Array<{ id: string; label: string; value: number; sub?: string }>;
  color?: string;
  valueLabel?: string;
}) {
  const max = Math.max(...items.map((i) => i.value), 1);

  return (
    <div className="space-y-1.5">
      {items.map((item) => (
        <div key={item.id} className="group relative">
          <div className="relative h-9 overflow-hidden rounded-md bg-surface-2">
            <div
              className="absolute inset-y-0 left-0 rounded-md transition-all"
              style={{
                width: `${Math.max((item.value / max) * 100, 1.5)}%`,
                background: color,
                opacity: 0.24,
              }}
            />
            <div className="relative flex h-full items-center justify-between gap-3 px-3">
              <span className="truncate text-xs text-ink-2">{item.label}</span>
              <span className="shrink-0 font-mono text-xs font-semibold text-ink">
                {compact(item.value)}
                <span className="ml-1 font-sans font-normal text-ink-3">{valueLabel}</span>
              </span>
            </div>
          </div>
          {item.sub && (
            <div className="mt-0.5 px-3 text-[10px] text-ink-3">{item.sub}</div>
          )}
        </div>
      ))}
    </div>
  );
}
