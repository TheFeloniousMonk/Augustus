/** Shared constants for the Augustus frontend. */

import type { Agent } from '../types';

/** Ordered color palette for per-agent visualization. */
export const AGENT_COLORS = [
  'var(--agent-1)',
  'var(--agent-2)',
  'var(--agent-3)',
];

/** Pick a consistent color for an agent based on its position in the list. */
export function getAgentColor(agentId: string, agents: Agent[]): string {
  const idx = agents.findIndex((a) => a.agent_id === agentId);
  return AGENT_COLORS[idx >= 0 ? idx % AGENT_COLORS.length : 0];
}

/**
 * Basin color palette — used consistently across trajectory charts,
 * overview panels, and co-activation networks.
 *
 * 16 colors: 8 from the brand guide trajectory spec + 8 extended
 * Deep Watch tones for agents with many basins. Ordered so adjacent
 * indices are maximally distinct (core/peripheral/emergent interleaved
 * with extended tones).
 */
export const BASIN_COLORS = [
  'var(--basin-core-1)',        // #3B9B8E  Verdigris
  'var(--basin-peripheral-1)',  // #D4915D  Amber
  'var(--basin-emergent-1)',    // #8B7EC8  Dusk
  'var(--basin-core-2)',        // #2E7D9B  Deep Water
  'var(--basin-peripheral-2)',  // #C4786E  Clay
  'var(--basin-ext-4)',         // #6B9B73  Sage Deep
  'var(--basin-ext-1)',         // #B87D4A  Copper
  'var(--basin-emergent-2)',    // #7A9BB8  Haze
  'var(--basin-core-3)',        // #5B8C6F  Forest
  'var(--basin-ext-3)',         // #9B6B9B  Plum
  'var(--basin-ext-6)',         // #AE9B5D  Ochre
  'var(--basin-ext-5)',         // #5D8AAE  Steel Blue
  'var(--basin-peripheral-3)',  // #9B8B5A  Lichen
  'var(--basin-ext-2)',         // #4AADA0  Seafoam
  'var(--basin-ext-7)',         // #A088B8  Mauve
  'var(--basin-ext-8)',         // #2B8C82  Teal Dark
] as const;

/**
 * Resolved hex values matching BASIN_COLORS order.
 * Recharts needs raw color strings (CSS vars don't resolve in SVG
 * stroke/fill attrs in all browsers), so the chart uses these directly.
 */
export const BASIN_COLOR_HEX = [
  '#3B9B8E', '#D4915D', '#8B7EC8', '#2E7D9B',
  '#C4786E', '#6B9B73', '#B87D4A', '#7A9BB8',
  '#5B8C6F', '#9B6B9B', '#AE9B5D', '#5D8AAE',
  '#9B8B5A', '#4AADA0', '#A088B8', '#2B8C82',
] as const;

/** Get a basin color by index (wraps around). */
export function getBasinColor(index: number): string {
  return BASIN_COLORS[index % BASIN_COLORS.length];
}

/** Simple string hash → positive integer. */
function hashName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Deterministic color for a basin name. Uses a hash so the same name
 * always maps to the same color regardless of render order.
 */
export function getBasinColorByName(name: string): string {
  return BASIN_COLOR_HEX[hashName(name) % BASIN_COLOR_HEX.length];
}

/** Default Claude model name used when no override is configured. */
export const DEFAULT_MODEL = 'claude-opus-4-6';
