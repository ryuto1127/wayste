import React from "react";
import type { TreeStage } from "@/lib/forest-state";

interface TreeSVGProps {
  stage: TreeStage;
  className?: string;
}

/** Soil mound shared across all stages. */
function SoilMound() {
  return (
    <ellipse cx="20" cy="53" rx="12" ry="3" fill="#6B4F3A" opacity="0.7" />
  );
}

/** Stage 0: just a soil mound. */
function EmptySlot() {
  return (
    <svg viewBox="0 0 40 56" width="36" height="52" aria-hidden="true">
      <SoilMound />
    </svg>
  );
}

/** Stage 1: seedling — thin stem + 2 tiny leaves. */
function Seedling() {
  return (
    <svg viewBox="0 0 40 56" width="36" height="52" aria-hidden="true">
      <SoilMound />
      {/* stem */}
      <line x1="20" y1="53" x2="20" y2="40" stroke="#7A9A4A" strokeWidth="1.5" strokeLinecap="round" />
      {/* left leaf */}
      <ellipse cx="16" cy="40" rx="4" ry="2.5" fill="#8BC34A" transform="rotate(-30 16 40)" />
      {/* right leaf */}
      <ellipse cx="24" cy="42" rx="4" ry="2.5" fill="#9CCC65" transform="rotate(25 24 42)" />
    </svg>
  );
}

/** Stage 2: small tree — short trunk, small leaf cluster. */
function SmallTree() {
  return (
    <svg viewBox="0 0 40 56" width="36" height="52" aria-hidden="true">
      <SoilMound />
      {/* trunk */}
      <rect x="18" y="36" width="4" height="17" rx="1.5" fill="#8D6E4C" />
      {/* canopy */}
      <ellipse cx="20" cy="32" rx="9" ry="8" fill="#66BB6A" />
      <ellipse cx="16" cy="34" rx="6" ry="5" fill="#4CAF50" />
      <ellipse cx="24" cy="35" rx="5" ry="4.5" fill="#81C784" />
    </svg>
  );
}

/** Stage 3: medium tree — taller trunk, wider canopy. */
function MediumTree() {
  return (
    <svg viewBox="0 0 40 56" width="36" height="52" aria-hidden="true">
      <SoilMound />
      {/* trunk */}
      <rect x="17" y="30" width="6" height="23" rx="2" fill="#795548" />
      {/* branch stubs */}
      <line x1="17" y1="38" x2="13" y2="35" stroke="#795548" strokeWidth="2" strokeLinecap="round" />
      <line x1="23" y1="40" x2="27" y2="37" stroke="#795548" strokeWidth="2" strokeLinecap="round" />
      {/* canopy */}
      <ellipse cx="20" cy="24" rx="14" ry="11" fill="#43A047" />
      <ellipse cx="14" cy="27" rx="8" ry="6" fill="#388E3C" />
      <ellipse cx="26" cy="28" rx="7" ry="5.5" fill="#4CAF50" />
      <ellipse cx="20" cy="20" rx="9" ry="6" fill="#66BB6A" />
    </svg>
  );
}

/** Stage 4: large tree — thick trunk, broad leafy canopy. */
function LargeTree() {
  return (
    <svg viewBox="0 0 40 56" width="36" height="52" aria-hidden="true">
      <SoilMound />
      {/* thick trunk */}
      <rect x="15" y="28" width="10" height="25" rx="3" fill="#6D4C41" />
      {/* root bumps */}
      <ellipse cx="14" cy="52" rx="3" ry="1.5" fill="#6D4C41" />
      <ellipse cx="26" cy="52" rx="3" ry="1.5" fill="#6D4C41" />
      {/* branch stubs */}
      <line x1="15" y1="36" x2="10" y2="32" stroke="#6D4C41" strokeWidth="2.5" strokeLinecap="round" />
      <line x1="25" y1="38" x2="30" y2="34" stroke="#6D4C41" strokeWidth="2.5" strokeLinecap="round" />
      <line x1="15" y1="32" x2="8" y2="28" stroke="#6D4C41" strokeWidth="2" strokeLinecap="round" />
      <line x1="25" y1="33" x2="32" y2="29" stroke="#6D4C41" strokeWidth="2" strokeLinecap="round" />
      {/* broad canopy — layered ellipses */}
      <ellipse cx="20" cy="20" rx="18" ry="14" fill="#2E7D32" />
      <ellipse cx="12" cy="24" rx="10" ry="7" fill="#388E3C" />
      <ellipse cx="28" cy="24" rx="10" ry="7" fill="#388E3C" />
      <ellipse cx="20" cy="16" rx="13" ry="9" fill="#43A047" />
      <ellipse cx="15" cy="19" rx="8" ry="6" fill="#4CAF50" />
      <ellipse cx="26" cy="18" rx="8" ry="6" fill="#4CAF50" />
      <ellipse cx="20" cy="13" rx="9" ry="5" fill="#66BB6A" />
    </svg>
  );
}

const STAGE_COMPONENTS: Record<TreeStage, React.FC> = {
  0: EmptySlot,
  1: Seedling,
  2: SmallTree,
  3: MediumTree,
  4: LargeTree,
};

/**
 * Renders an inline SVG tree at the given growth stage (0-4).
 * Designed for compact row layout (~28px wide, 40px tall).
 */
export default function TreeSVG({ stage, className }: TreeSVGProps) {
  const Component = STAGE_COMPONENTS[stage];
  return (
    <span className={className} style={{ display: "inline-flex", lineHeight: 0 }}>
      <Component />
    </span>
  );
}
