import type { FacilityRequest } from './request.ts';

/**
 * Cross-period ramp window (mol/s) reachable inside one allocation period.
 * floor: down-ramp limit, a hard physical lower bound the flow cannot fall below.
 * ceiling: up-ramp limit, a hard physical upper bound the flow cannot rise above.
 */
export type RampWindow = { cavernId: string; floorMolPerSecond: number; ceilingMolPerSecond: number };

export function rampWindowFor(item: FacilityRequest, horizonHours: number): RampWindow {
  const previous = item.previousMolPerSecond ?? 0;
  const rate = item.rampMolPerSecondPerHour ?? Infinity;
  // Unlimited rate stays unlimited at every finite horizon (avoids Infinity * 0 = NaN);
  // a zero horizon with a finite rate freezes the flow at its previous value.
  if (!Number.isFinite(rate)) return { cavernId: item.cavernId, floorMolPerSecond: 0, ceilingMolPerSecond: Infinity };
  const maxChange = rate * horizonHours;
  return {
    cavernId: item.cavernId,
    floorMolPerSecond: Math.max(0, previous - maxChange),
    ceilingMolPerSecond: previous + maxChange,
  };
}

export function rampWindows(requests: FacilityRequest[], horizonHours: number): Map<string, RampWindow> {
  return new Map(requests.map((item) => [item.cavernId, rampWindowFor(item, horizonHours)]));
}
