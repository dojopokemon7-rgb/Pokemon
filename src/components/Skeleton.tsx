/**
 * Skeleton — flat, token-driven loading placeholder (Batch 2B · Item 3).
 *
 * NeoPOP-faithful: square corners (radius 0 by design — AGENTS.md #10),
 * NO blur, NO backdrop-filter, NO glow. The pulse is a CSS CLASS
 * (`.dojo-skeleton` in globals.css) — NOT an inline animation — so the
 * global `@media (prefers-reduced-motion: reduce)` block automatically
 * disables it for opt-out users (inline styles are not covered by that
 * media query). Background is `--color-dojo-raised`.
 *
 * It is a pure presentational `<div>` (no hooks), so it is server-safe
 * and needs no "use client".
 *
 * The pulse loop stays ~1.5s (the existing `@keyframes dojo-pulse`) — a
 * calm shimmer, NOT the 150–200ms snappy budget. That snappy budget
 * applies to the Item-4 fade-in on the skeleton→content SWAP, not to the
 * infinite loading loop (shortening the loop to 150ms would strobe).
 *
 * Compose these primitives for the three shapes used (tile / block /
 * line) rather than adding bespoke components (fewest files).
 */
import type { CSSProperties } from "react";

export interface SkeletonProps {
  /** Defaults to "100%". */
  width?: string | number;
  /** Required for line/block variants (ignored when aspectRatio is set). */
  height?: string | number;
  /** e.g. "660 / 921" for card art; overrides height when provided. */
  aspectRatio?: string;
  /** Square only — the prop documents intent; the value is always 0. */
  radius?: 0;
  className?: string;
  style?: CSSProperties;
  /** Skeletons are decorative; hidden from assistive tech by default. */
  "aria-hidden"?: boolean;
}

export function Skeleton({
  width = "100%",
  height,
  aspectRatio,
  className,
  style,
  "aria-hidden": ariaHidden = true,
}: SkeletonProps) {
  return (
    <div
      aria-hidden={ariaHidden}
      className={`dojo-skeleton${className ? ` ${className}` : ""}`}
      style={{
        width,
        ...(aspectRatio ? { aspectRatio } : height != null ? { height } : {}),
        borderRadius: 0,
        ...style,
      }}
    />
  );
}
