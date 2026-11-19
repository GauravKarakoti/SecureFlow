"use client";

import React from "react";
import type { WeeklyTrendPoint } from "@/lib/repositories/types";

interface TrendSparklineProps {
  data: WeeklyTrendPoint[];
  width?: number;
  height?: number;
  className?: string;
}

export function TrendSparkline({
  data,
  width = 120,
  height = 32,
  className = "",
}: TrendSparklineProps) {
  // If no data or all scores are null, show empty/unranked line
  const validPoints = data.filter((d) => d.score !== null);
  if (validPoints.length === 0) {
    return (
      <div
        className={`flex items-center justify-center text-[11px] font-mono text-zinc-500 ${className}`}
        style={{ width, height }}
        title="No historical trend data"
      >
        <svg width={width} height={height} className="overflow-visible">
          <line
            x1="4"
            y1={height / 2}
            x2={width - 4}
            y2={height / 2}
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray="3 3"
            className="text-zinc-700"
          />
        </svg>
      </div>
    );
  }

  const paddingX = 6;
  const paddingY = 6;
  const availableWidth = width - paddingX * 2;
  const availableHeight = height - paddingY * 2;

  // X coordinate distributed across 8 weeks (data.length - 1 intervals)
  const stepX = data.length > 1 ? availableWidth / (data.length - 1) : 0;

  // Map each data point to (x, y) coordinates
  const coords: Array<{ x: number; y: number; score: number; label: string }> = [];
  data.forEach((pt, idx) => {
    if (pt.score !== null) {
      const x = paddingX + idx * stepX;
      // score 100 -> paddingY (top), score 0 -> paddingY + availableHeight (bottom)
      const normalizedScore = Math.max(0, Math.min(100, pt.score));
      const y = paddingY + (1 - normalizedScore / 100) * availableHeight;
      coords.push({ x, y, score: pt.score, label: pt.weekLabel });
    }
  });

  if (coords.length === 0) {
    return null;
  }

  // Determine line color from the latest score
  const latestScore = coords[coords.length - 1].score;
  let strokeColor = "stroke-emerald-400";
  let fillColor = "fill-emerald-400";
  let gradientId = "trend-green";

  if (latestScore < 50) {
    strokeColor = "stroke-rose-400";
    fillColor = "fill-rose-400";
    gradientId = "trend-red";
  } else if (latestScore < 75) {
    strokeColor = "stroke-amber-400";
    fillColor = "fill-amber-400";
    gradientId = "trend-amber";
  }

  // Construct SVG path string
  const pathD = coords.reduce((acc, pt, idx) => {
    return idx === 0 ? `M ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}` : `${acc} L ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`;
  }, "");

  // Area under curve path
  const areaD = `${pathD} L ${coords[coords.length - 1].x.toFixed(1)} ${height - paddingY} L ${coords[0].x.toFixed(1)} ${height - paddingY} Z`;

  const tooltipText = data
    .map((d) => `${d.weekLabel}: ${d.score !== null ? `${d.score}/100` : "No scans"}`)
    .join(" | ");

  const lastCoord = coords[coords.length - 1];

  return (
    <div
      className={`relative inline-flex items-center ${className}`}
      title={tooltipText}
      aria-label={`8-week trend: ${tooltipText}`}
    >
      <svg width={width} height={height} className="overflow-visible">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.25" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.0" />
          </linearGradient>
        </defs>

        {/* Fill area under trend line */}
        <path d={areaD} className={`${fillColor} opacity-20`} fill="currentColor" />

        {/* Trend Polyline */}
        <path
          d={pathD}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={strokeColor}
        />

        {/* Latest point indicator */}
        <circle
          cx={lastCoord.x}
          cy={lastCoord.y}
          r="3"
          className={`${fillColor} stroke-zinc-950`}
          strokeWidth="1.5"
        />
      </svg>
    </div>
  );
}
