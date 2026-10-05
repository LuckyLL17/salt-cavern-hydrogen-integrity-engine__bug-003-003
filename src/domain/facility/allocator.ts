import { DomainError } from '../errors.ts';
import { priorityBands, requiredMinimumFlow } from './priority-policy.ts';
import { applyRampBounds, type RampAdjustedRequest } from './ramp.ts';
import { validateRequests, type FacilityRequest } from './request.ts';
export type FacilityAllocation = FacilityRequest & {
  allocatedMolPerSecond: number;
  curtailedMolPerSecond: number;
  rampAdjustedRequestMolPerSecond: number;
  rampAdjustedMinimumMolPerSecond: number;
  rampCurtailedMolPerSecond: number;
  disposition: 'served' | 'minimum-curtailed' | 'capacity-curtailed';
  reasons: string[];
};
const EPSILON = 1e-9;
function requestWeight(item: FacilityRequest): number { return Math.max(0, item.weight ?? 1); }
function requestHeadroom(item: FacilityRequest, current: number): number { return Math.max(0, item.requestedMolPerSecond - current); }
function allocationTotal(values: Map<string, number>): number { return [...values.values()].reduce((sum, value) => sum + value, 0); }
function weightedShare(capacity: number, weight: number, totalWeight: number): number { return totalWeight <= 0 ? 0 : capacity * weight / totalWeight; }
function weightedWaterFill(band: FacilityRequest[], capacity: number, minimumsFit: boolean): Map<string, number> {
  const allocated = new Map<string, number>();
  for (const item of band) {
    allocated.set(item.cavernId, minimumsFit ? Math.min(item.minimumMolPerSecond, item.requestedMolPerSecond) : 0);
  }
  let pool = Math.max(0, capacity - allocationTotal(allocated));
  let active = band.filter((item) => requestHeadroom(item, allocated.get(item.cavernId) ?? 0) > EPSILON && requestWeight(item) > 0);
  while (pool > EPSILON && active.length > 0) {
    const weightTotal = active.reduce((sum, item) => sum + requestWeight(item), 0);
    if (weightTotal <= 0) break;
    let distributed = 0;
    const stillActive: FacilityRequest[] = [];
    for (const item of active) {
      const current = allocated.get(item.cavernId) ?? 0;
      const grant = Math.min(weightedShare(pool, requestWeight(item), weightTotal), requestHeadroom(item, current));
      allocated.set(item.cavernId, current + grant);
      distributed += grant;
      if (requestHeadroom(item, current + grant) > EPSILON) stillActive.push(item);
    }
    pool = Math.max(0, pool - distributed);
    if (distributed <= EPSILON) break;
    active = stillActive;
  }
  return allocated;
}
function buildAllocation(item: RampAdjustedRequest, amount: number, minimumsFit: boolean, bandStarved: boolean): FacilityAllocation {
  const { nominalRequestMolPerSecond, nominalMinimumMolPerSecond, rampCurtailedMolPerSecond, rampReasons, ...effective } = item;
  const reasons = [...rampReasons];
  if (!minimumsFit) reasons.push('band-minimum-infeasible');
  if (bandStarved) reasons.push('priority-capacity-exhausted');
  let disposition: FacilityAllocation['disposition'];
  if (amount + EPSILON < effective.minimumMolPerSecond) {
    disposition = 'minimum-curtailed';
    reasons.push('minimum-curtailed');
  } else if (amount + EPSILON >= effective.requestedMolPerSecond) {
    disposition = 'served';
  } else {
    disposition = 'capacity-curtailed';
    reasons.push('capacity-curtailed');
  }
  return {
    ...effective,
    requestedMolPerSecond: nominalRequestMolPerSecond,
    minimumMolPerSecond: nominalMinimumMolPerSecond,
    rampAdjustedRequestMolPerSecond: effective.requestedMolPerSecond,
    rampAdjustedMinimumMolPerSecond: effective.minimumMolPerSecond,
    rampCurtailedMolPerSecond,
    allocatedMolPerSecond: amount,
    curtailedMolPerSecond: Math.max(0, effective.requestedMolPerSecond - amount),
    disposition,
    reasons,
  };
}
export function allocateSharedCapacity(requests: FacilityRequest[], stationCapacityMolPerSecond: number, horizonHours = 1): FacilityAllocation[] {
  if (!(horizonHours >= 0) || !Number.isFinite(horizonHours)) throw new DomainError('INVALID_ALLOCATION_HORIZON', 'Allocation horizon must be finite and non-negative', 422);
  const adjusted = applyRampBounds(validateRequests(requests, stationCapacityMolPerSecond), horizonHours);
  const results = new Map<string, FacilityAllocation>();
  let remaining = stationCapacityMolPerSecond;
  for (const band of priorityBands(adjusted)) {
    const minimumsFit = requiredMinimumFlow(band) <= remaining + EPSILON;
    const bandStarved = remaining <= EPSILON && band.some((item) => item.requestedMolPerSecond > EPSILON);
    const allocations = weightedWaterFill(band, remaining, minimumsFit);
    for (const item of band) {
      results.set(item.cavernId, buildAllocation(item, allocations.get(item.cavernId) ?? 0, minimumsFit, bandStarved));
    }
    remaining = Math.max(0, remaining - allocationTotal(allocations));
  }
  return requests.map((item) => results.get(item.cavernId)!);
}
