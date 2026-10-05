import { DomainError } from '../errors.ts';
import { validateRequests, type FacilityRequest } from './request.ts';
export type { FacilityRequest } from './request.ts';
import { rampWindows } from './ramp.ts';
import {
  priorityBands,
  resolveEffectivePlans,
  type EffectivePlan,
} from './priority-policy.ts';

export type AllocationDisposition = 'served' | 'minimum-curtailed' | 'capacity-curtailed';

/** Machine-readable reason codes explaining why an allocation differs from its request. */
export type AllocationReason =
  | 'served-in-full'
  | 'ramp-up-limited'
  | 'ramp-down-forced'
  | 'minimum-feasible-weighted-ration'
  | 'minimum-curtailed-pro-rata'
  | 'preempted-by-higher-priority'
  | 'forced-ramp-floor-exceeds-capacity';

export type FacilityAllocation = {
  cavernId: string;
  priority: number;
  weight: number;
  requestedMolPerSecond: number;
  minimumMolPerSecond: number;
  previousMolPerSecond: number;
  rampMolPerSecondPerHour?: number;
  rampFloorMolPerSecond: number;
  rampCeilingMolPerSecond: number;
  effectiveCapMolPerSecond: number;
  minimumEntitlementMolPerSecond: number;
  allocatedMolPerSecond: number;
  /** unmet part of the request: max(0, request - allocated) */
  curtailedMolPerSecond: number;
  /** flow forced above the request because the period is too short to ramp down: max(0, allocated - request) */
  forcedSurplusMolPerSecond: number;
  /** curtailment attributable to the up-ramp ceiling */
  rampLimitedMolPerSecond: number;
  /** curtailment attributable to scarce shared capacity (including pro-rata minimum cuts) */
  capacityCurtailedMolPerSecond: number;
  /** signed allocated - request: negative for curtailment, positive for forced surplus */
  deviationMolPerSecond: number;
  /** allocated - previous: signed cross-period change, always within the ramp window */
  rampChangeMolPerSecond: number;
  disposition: AllocationDisposition;
  reasons: AllocationReason[];
};

export type PriorityBandReport = {
  priority: number;
  cavernIds: string[];
  /** hard down-ramp flow pre-guaranteed for this band before competition */
  forcedFloorMolPerSecond: number;
  /** discretionary pool (above all forced floors) available when the band was reached */
  capacityAvailableMolPerSecond: number;
  /** above-floor minimum need that must fit for the band to be feasible */
  minimumNeedMolPerSecond: number;
  minimumFeasible: boolean;
  /** fraction of the above-floor minimum need actually served (1 when feasible, 0..1 for a fair cut, 0 when preempted with unmet need) */
  minimumSatisfactionFraction: number;
  /** 'minimums-pro-rata' | 'minimums-first-weighted-waterfill' | 'preempted' */
  phase: string;
  /** discretionary pool consumed by this band */
  drawnFromPoolMolPerSecond: number;
  /** total flow assigned to this band (forced floors + pool draw) */
  consumedMolPerSecond: number;
  /** discretionary pool left for lower priorities after the band */
  residualCapacityMolPerSecond: number;
};

export type AllocationTotals = {
  stationCapacityMolPerSecond: number;
  requestedMolPerSecond: number;
  /** sum of hard down-ramp floors guaranteed before priority competition */
  forcedRampFloorMolPerSecond: number;
  /** positive when the forced floors alone exceed station capacity (physically infeasible period) */
  forcedFloorOverflowMolPerSecond: number;
  allocatedMolPerSecond: number;
  curtailedMolPerSecond: number;
  /** total flow forced above requests because periods are too short to ramp down */
  forcedSurplusMolPerSecond: number;
  /** signed sum of (allocated - requested): curtailment negative, forced surplus positive */
  netDeviationMolPerSecond: number;
  rampLimitedMolPerSecond: number;
  capacityCurtailedMolPerSecond: number;
  unusedCapacityMolPerSecond: number;
};

export type AllocationReport = {
  horizonHours: number;
  allocations: FacilityAllocation[];
  bands: PriorityBandReport[];
  totals: AllocationTotals;
};

const EPS = 1e-9;

type BandDecision = {
  phase: PriorityBandReport['phase'];
  minimumFeasible: boolean;
  minimumSatisfactionFraction: number;
  allocations: Map<string, number>;
  capacityAtEntry: number;
  need: number;
  floors: number;
  consumed: number;
  drawnFromPool: number;
  residualAfter: number;
};

/**
 * Iterative weighted water fill above guaranteed starting levels.
 *
 * Every member starts at its guaranteed level (minimum entitlement, once the band is
 * known to be feasible) and the surplus pool is shared in proportion to weight;
 * whenever a member reaches its cap its share is removed and the pool is redistributed
 * among the still-active members. Iterating to a fixed point guarantees no capacity is
 * stranded by early caps and that equal weights converge to equal levels (up to each
 * member's cap). Returns allocations including ramp floors.
 */
function weightedWaterFill(members: EffectivePlan[], surplusPool: number, startFor: (m: EffectivePlan) => number): Map<string, number> {
  const allocations = new Map<string, number>(members.map((m) => [m.cavernId, startFor(m)]));
  let active = members.filter((m) => startFor(m) < m.effectiveCapMolPerSecond - EPS);
  let remaining = Math.max(0, surplusPool);
  while (active.length > 0 && remaining > EPS) {
    const weightTotal = active.reduce((sum, m) => sum + Math.max(0, m.weight ?? 1), 0);
    if (weightTotal <= 0) break;
    const stillActive: EffectivePlan[] = [];
    let distributed = 0;
    for (const m of active) {
      const share = remaining * (m.weight ?? 1) / weightTotal;
      const current = allocations.get(m.cavernId) ?? startFor(m);
      const headroom = Math.max(0, m.effectiveCapMolPerSecond - current);
      const added = Math.min(share, headroom);
      allocations.set(m.cavernId, current + added);
      distributed += added;
      // A member that still has headroom after taking its full share stays in the pool;
      // a member that reaches its cap exits so its weight is released for redistribution.
      if (headroom > share + EPS) stillActive.push(m);
    }
    remaining = Math.max(0, remaining - distributed);
    active = stillActive;
  }
  return allocations;
}

/** Above-floor minimum need for one band: the discretionary pool volume the band must receive to be feasible. */
function minimumNeedAboveFloor(band: EffectivePlan[]): number {
  return band.reduce((sum, m) => sum + Math.max(0, m.minimumEntitlementMolPerSecond - m.rampFloorMolPerSecond), 0);
}

/**
 * Fair pro-rata cut inside one priority when its minimum entitlements do not fit:
 * every member (floors pre-paid) receives the same fraction of the minimum need
 * above its forced floor. The infeasible band draws its whole entry pool (exactly,
 * to avoid leaking floating-point dust to lower priorities), so lower priorities
 * cannot jump the queue.
 */
function proRataMinimums(members: EffectivePlan[], pool: number): Map<string, number> {
  const allocations = new Map<string, number>();
  const needAboveFloor = minimumNeedAboveFloor(members);
  const fraction = needAboveFloor > EPS ? Math.min(1, Math.max(0, pool / needAboveFloor)) : 0;
  const competing = members.filter((m) => m.minimumEntitlementMolPerSecond - m.rampFloorMolPerSecond > EPS);
  competing.forEach((m, index) => {
    const aboveFloor = Math.max(0, m.minimumEntitlementMolPerSecond - m.rampFloorMolPerSecond);
    let value: number;
    if (index === competing.length - 1) {
      // Last competing member absorbs rounding so the drawn total equals the entry pool exactly.
      const alreadyDrawn = competing.slice(0, index).reduce(
        (sum, other) => sum + (allocations.get(other.cavernId) ?? other.rampFloorMolPerSecond) - other.rampFloorMolPerSecond, 0);
      value = m.rampFloorMolPerSecond + Math.min(aboveFloor, Math.max(0, pool - alreadyDrawn));
    } else {
      value = m.rampFloorMolPerSecond + aboveFloor * fraction;
    }
    allocations.set(m.cavernId, value);
  });
  for (const m of members) if (!allocations.has(m.cavernId)) allocations.set(m.cavernId, m.rampFloorMolPerSecond);
  return allocations;
}

function decideBand(band: EffectivePlan[], poolAtEntry: number): BandDecision {
  const need = minimumNeedAboveFloor(band);
  const floors = band.reduce((sum, m) => sum + m.rampFloorMolPerSecond, 0);
  const base = { capacityAtEntry: poolAtEntry, need };
  if (need > poolAtEntry + EPS) {
    const allocations = proRataMinimums(band, poolAtEntry);
    const fraction = need > EPS ? Math.min(1, poolAtEntry / need) : 1;
    // The whole entry pool is consumed by an infeasible band; lower priorities get nothing.
    return {
      ...base,
      phase: 'minimums-pro-rata',
      minimumFeasible: false,
      minimumSatisfactionFraction: fraction,
      allocations,
      floors,
      consumed: floors + poolAtEntry,
      drawnFromPool: poolAtEntry,
      residualAfter: 0,
    };
  }
  // Minimums are guaranteed first; only the residual surplus competes on weight.
  const surplus = poolAtEntry - need;
  const allocations = weightedWaterFill(band, surplus, (m) => m.minimumEntitlementMolPerSecond);
  const drawn = band.reduce((sum, m) => sum + (allocations.get(m.cavernId) ?? m.rampFloorMolPerSecond) - m.rampFloorMolPerSecond, 0);
  return {
    ...base,
    phase: 'minimums-first-weighted-waterfill',
    minimumFeasible: true,
    minimumSatisfactionFraction: 1,
    allocations,
    floors,
    consumed: floors + drawn,
    drawnFromPool: drawn,
    residualAfter: Math.max(0, poolAtEntry - drawn),
  };
}

function buildAllocation(
  plan: EffectivePlan,
  allocated: number,
  phase: PriorityBandReport['phase'] | 'preempted',
  totalsOverflow: boolean,
): FacilityAllocation {
  const curtailed = Math.max(0, plan.requestedMolPerSecond - allocated);
  const forcedSurplus = Math.max(0, allocated - plan.requestedMolPerSecond);
  const upLimitedRequest = Number.isFinite(plan.rampCeilingMolPerSecond) ? Math.min(plan.requestedMolPerSecond, plan.rampCeilingMolPerSecond) : plan.requestedMolPerSecond;
  // Up-ramp curtailment is the part of the request above the up-ramp ceiling. A cavern forced
  // to stay above its request by the down-ramp floor has upLimitedRequest == request, hence 0;
  // a frozen flow (zero-width window) is correctly reported as up-ramp limited.
  const rampLimited = Math.max(0, plan.requestedMolPerSecond - upLimitedRequest);
  const capacityCurtailed = Math.max(0, curtailed - rampLimited);
  const deviation = allocated - plan.requestedMolPerSecond;
  const rampChange = allocated - plan.previousMolPerSecond;
  const minimumServed = allocated >= plan.minimumEntitlementMolPerSecond - EPS;

  let disposition: AllocationDisposition;
  if (!minimumServed) disposition = 'minimum-curtailed';
  // If shared capacity is not binding beyond the up-ramp ceiling, the achievable request is served
  // (the ramp-up-limited reason still explains the unmet part of the original request).
  else if (capacityCurtailed <= EPS) disposition = 'served';
  else disposition = 'capacity-curtailed';

  const reasons: AllocationReason[] = [];
  if (totalsOverflow) reasons.push('forced-ramp-floor-exceeds-capacity');
  if (forcedSurplus > EPS) reasons.push('ramp-down-forced');
  if (phase === 'preempted') {
    if (curtailed > EPS) reasons.push('preempted-by-higher-priority');
  } else if (phase === 'minimums-pro-rata') {
    if (allocated < plan.minimumEntitlementMolPerSecond - EPS) reasons.push('minimum-curtailed-pro-rata');
  } else {
    if (rampLimited > EPS) reasons.push('ramp-up-limited');
    if (capacityCurtailed > EPS) reasons.push('minimum-feasible-weighted-ration');
    if (reasons.length === 0) reasons.push('served-in-full');
  }

  return {
    cavernId: plan.cavernId,
    priority: plan.priority,
    weight: plan.weight ?? 1,
    requestedMolPerSecond: plan.requestedMolPerSecond,
    minimumMolPerSecond: plan.minimumMolPerSecond,
    previousMolPerSecond: plan.previousMolPerSecond,
    ...(plan.rampMolPerSecondPerHour !== undefined ? { rampMolPerSecondPerHour: plan.rampMolPerSecondPerHour } : {}),
    rampFloorMolPerSecond: plan.rampFloorMolPerSecond,
    rampCeilingMolPerSecond: plan.rampCeilingMolPerSecond,
    effectiveCapMolPerSecond: plan.effectiveCapMolPerSecond,
    minimumEntitlementMolPerSecond: plan.minimumEntitlementMolPerSecond,
    allocatedMolPerSecond: allocated,
    curtailedMolPerSecond: curtailed,
    forcedSurplusMolPerSecond: forcedSurplus,
    rampLimitedMolPerSecond: rampLimited,
    capacityCurtailedMolPerSecond: capacityCurtailed,
    deviationMolPerSecond: deviation,
    rampChangeMolPerSecond: rampChange,
    disposition,
    reasons,
  };
}

export function planSharedCapacity(
  requests: FacilityRequest[],
  stationCapacityMolPerSecond: number,
  horizonHours = 1,
): AllocationReport {
  if (!(horizonHours >= 0) || !Number.isFinite(horizonHours)) throw new DomainError('INVALID_ALLOCATION_HORIZON', 'Allocation horizon must be finite and non-negative', 422);
  const validated = validateRequests(requests, stationCapacityMolPerSecond);
  const windows = rampWindows(validated, horizonHours);
  const plans = resolveEffectivePlans(validated, windows);

  const forcedFloor = plans.reduce((sum, p) => sum + p.rampFloorMolPerSecond, 0);
  const forcedOverflow = Math.max(0, forcedFloor - stationCapacityMolPerSecond);
  // Forced floors are physical and are guaranteed first; the pool below is all that priority competition can use.
  let residual = Math.max(0, stationCapacityMolPerSecond - forcedFloor);

  const decisions = new Map<string, { allocated: number; phase: PriorityBandReport['phase'] | 'preempted' }>();
  const bandReports: PriorityBandReport[] = [];
  let preempted = false;
  for (const band of priorityBands(plans)) {
    const bandFloors = band.reduce((sum, p) => sum + p.rampFloorMolPerSecond, 0);
    if (preempted) {
      const preemptedNeed = minimumNeedAboveFloor(band);
      for (const p of band) decisions.set(p.cavernId, { allocated: p.rampFloorMolPerSecond, phase: 'preempted' });
      bandReports.push({
        priority: band[0].priority,
        cavernIds: band.map((p) => p.cavernId),
        forcedFloorMolPerSecond: bandFloors,
        capacityAvailableMolPerSecond: residual,
        minimumNeedMolPerSecond: preemptedNeed,
        minimumFeasible: preemptedNeed <= EPS,
        minimumSatisfactionFraction: preemptedNeed <= EPS ? 1 : 0,
        phase: 'preempted',
        drawnFromPoolMolPerSecond: 0,
        consumedMolPerSecond: bandFloors,
        residualCapacityMolPerSecond: residual,
      });
      continue;
    }
    const decision = decideBand(band, residual);
    for (const p of band) {
      decisions.set(p.cavernId, {
        allocated: decision.allocations.get(p.cavernId) ?? p.rampFloorMolPerSecond,
        phase: decision.phase,
      });
    }
    residual = decision.residualAfter;
    if (!decision.minimumFeasible) preempted = true;
    bandReports.push({
      priority: band[0].priority,
      cavernIds: band.map((p) => p.cavernId),
      forcedFloorMolPerSecond: bandFloors,
      capacityAvailableMolPerSecond: decision.capacityAtEntry,
      minimumNeedMolPerSecond: decision.need,
      minimumFeasible: decision.minimumFeasible,
      minimumSatisfactionFraction: decision.minimumSatisfactionFraction,
      phase: decision.phase,
      drawnFromPoolMolPerSecond: decision.drawnFromPool,
      consumedMolPerSecond: decision.consumed,
      residualCapacityMolPerSecond: decision.residualAfter,
    });
  }

  const allocations = plans.map((plan) => {
    const d = decisions.get(plan.cavernId)!;
    return buildAllocation(plan, d.allocated, d.phase, forcedOverflow > EPS);
  });

  const requested = allocations.reduce((sum, a) => sum + a.requestedMolPerSecond, 0);
  const allocated = allocations.reduce((sum, a) => sum + a.allocatedMolPerSecond, 0);
  const curtailed = allocations.reduce((sum, a) => sum + a.curtailedMolPerSecond, 0);
  const forcedSurplus = allocations.reduce((sum, a) => sum + a.forcedSurplusMolPerSecond, 0);
  const totals: AllocationTotals = {
    stationCapacityMolPerSecond,
    requestedMolPerSecond: requested,
    forcedRampFloorMolPerSecond: forcedFloor,
    forcedFloorOverflowMolPerSecond: forcedOverflow,
    allocatedMolPerSecond: allocated,
    curtailedMolPerSecond: curtailed,
    forcedSurplusMolPerSecond: forcedSurplus,
    netDeviationMolPerSecond: allocated - requested,
    rampLimitedMolPerSecond: allocations.reduce((sum, a) => sum + a.rampLimitedMolPerSecond, 0),
    capacityCurtailedMolPerSecond: allocations.reduce((sum, a) => sum + a.capacityCurtailedMolPerSecond, 0),
    unusedCapacityMolPerSecond: Math.max(0, stationCapacityMolPerSecond - allocated),
  };

  return { horizonHours, allocations, bands: bandReports, totals };
}

/** Backwards-compatible flat result: one allocation row per request, in request order. */
export function allocateSharedCapacity(
  requests: FacilityRequest[],
  stationCapacityMolPerSecond: number,
  horizonHours = 1,
): FacilityAllocation[] {
  return planSharedCapacity(requests, stationCapacityMolPerSecond, horizonHours).allocations;
}
