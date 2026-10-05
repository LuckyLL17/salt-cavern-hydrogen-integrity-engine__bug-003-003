import type { FacilityRequest } from './request.ts';

/**
 * A cavern's effective plan after cross-period ramp limits are applied.
 *
 * The ramp floor is a *physical* lower bound for this period: the flow cannot fall
 * below it regardless of priority or station scarcity. When the floor already meets
 * or exceeds the (up-ramp capped) request, the cavern is "pinned" — its flow is forced
 * and it takes no part in discretionary competition.
 */
export type EffectivePlan = Omit<FacilityRequest, 'previousMolPerSecond'> & {
  /** always populated after validation (defaults to 0) */
  previousMolPerSecond: number;
  /** hard down-ramp floor: flow cannot be reduced below this within the period */
  rampFloorMolPerSecond: number;
  /** hard up-ramp ceiling: flow cannot rise above this within the period */
  rampCeilingMolPerSecond: number;
  /** effective cap honoured in competition: the request limited by the up-ramp ceiling, never below the forced floor */
  effectiveCapMolPerSecond: number;
  /** non-discretionary entitlement: max(contractual minimum, ramp floor), capped at the effective cap */
  minimumEntitlementMolPerSecond: number;
  /** true when the down-ramp floor alone reaches/exceeds the achievable request */
  rampPinned: boolean;
};

export function priorityBands<T extends FacilityRequest>(requests: T[]): T[][] {
  const priorities = [...new Set(requests.map((item) => item.priority))].sort((a, b) => b - a);
  return priorities.map((priority) => requests.filter((item) => item.priority === priority).sort((a, b) => a.cavernId.localeCompare(b.cavernId)));
}

function planOf(item: FacilityRequest, rampFloor: number, rampCeiling: number): EffectivePlan {
  // With no up-ramp limit the ceiling is Infinity; the request itself is then the binding cap.
  const upLimitedRequest = Number.isFinite(rampCeiling) ? Math.min(item.requestedMolPerSecond, rampCeiling) : item.requestedMolPerSecond;
  const effectiveCap = Math.max(upLimitedRequest, rampFloor);
  const minimumEntitlement = Math.min(effectiveCap, Math.max(item.minimumMolPerSecond, rampFloor));
  return {
    ...item,
    previousMolPerSecond: item.previousMolPerSecond ?? 0,
    rampFloorMolPerSecond: rampFloor,
    rampCeilingMolPerSecond: rampCeiling,
    effectiveCapMolPerSecond: effectiveCap,
    minimumEntitlementMolPerSecond: minimumEntitlement,
    rampPinned: rampFloor >= upLimitedRequest,
  };
}

/**
 * Resolve every request against its ramp window. Ramp floors are guaranteed before
 * priority competition starts, so an infeasibly fast down-ramp cannot be ordered.
 */
export function resolveEffectivePlans(
  requests: FacilityRequest[],
  windows: Map<string, { floorMolPerSecond: number; ceilingMolPerSecond: number }>,
): EffectivePlan[] {
  return requests.map((item) => {
    const window = windows.get(item.cavernId) ?? { floorMolPerSecond: 0, ceilingMolPerSecond: Infinity };
    return planOf(item, window.floorMolPerSecond, window.ceilingMolPerSecond);
  });
}

/** Contractual minimum stable flow for a band (pre-ramp view). */
export function requiredMinimumFlow(band: FacilityRequest[]): number {
  return band.reduce((sum, item) => sum + item.minimumMolPerSecond, 0);
}

/** Non-discretionary minimum entitlement that must be served for the band to be feasible. */
export function bandMinimumNeed(band: EffectivePlan[]): number {
  return band.reduce((sum, item) => sum + item.minimumEntitlementMolPerSecond, 0);
}
