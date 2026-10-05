import { DomainError } from '../errors.ts';
import { priorityBands, requiredMinimumFlow } from './priority-policy.ts';
import { applyRampBounds } from './ramp.ts';
import { validateRequests, type FacilityRequest } from './request.ts';
export type FacilityAllocation = FacilityRequest & { allocatedMolPerSecond: number; curtailedMolPerSecond: number; disposition: 'served' | 'minimum-curtailed' | 'capacity-curtailed' };
function requestWeight(item: FacilityRequest): number { return Math.max(0, item.weight ?? 1); }
function requestHeadroom(item: FacilityRequest, current: number): number { return Math.max(0, item.requestedMolPerSecond - current); }
function allocationTotal(values: Map<string, number>): number { return [...values.values()].reduce((sum, value) => sum + value, 0); }
function weightedShare(capacity: number, weight: number, totalWeight: number): number { return totalWeight <= 0 ? 0 : capacity * weight / totalWeight; }
function weightedWaterFill(band: FacilityRequest[], capacity: number, minimumsFit: boolean): Map<string, number> {
  const allocated = new Map<string, number>();
  const minimumBudget = minimumsFit ? band.reduce((sum, item) => sum + Math.min(item.minimumMolPerSecond, item.requestedMolPerSecond), 0) : 0;
  const usable = Math.max(0, capacity - minimumBudget);
  for (const item of band) {
    const minimum = minimumsFit ? Math.min(item.minimumMolPerSecond, item.requestedMolPerSecond) : 0;
    allocated.set(item.cavernId, minimum);
  }
  const active = band.filter((item) => (allocated.get(item.cavernId) ?? 0) < item.requestedMolPerSecond);
  const weightTotal = active.reduce((sum, item) => sum + requestWeight(item), 0);
  if (weightTotal <= 0) return allocated;
  for (const item of active) {
    const current = allocated.get(item.cavernId) ?? 0;
    const share = weightedShare(usable, requestWeight(item), weightTotal);
    allocated.set(item.cavernId, Math.min(item.requestedMolPerSecond, current + Math.min(requestHeadroom(item, current), share)));
  }
  return allocated;
}
export function allocateSharedCapacity(requests: FacilityRequest[], stationCapacityMolPerSecond: number, horizonHours = 1): FacilityAllocation[] {
  if (!(horizonHours >= 0) || !Number.isFinite(horizonHours)) throw new DomainError('INVALID_ALLOCATION_HORIZON', 'Allocation horizon must be finite and non-negative', 422);
  const adjusted = applyRampBounds(validateRequests(requests, stationCapacityMolPerSecond), horizonHours);
  const results = new Map<string, FacilityAllocation>();
  let remaining = stationCapacityMolPerSecond;
  for (const band of priorityBands(adjusted)) {
    const minimumFits = requiredMinimumFlow(band) <= remaining + 1e-9;
    const desired = band.reduce((sum, item) => sum + item.requestedMolPerSecond, 0);
    const allocations = weightedWaterFill(band, Math.min(remaining, desired), minimumFits);
    for (const request of band) {
      const amount = allocations.get(request.cavernId) ?? 0;
      const disposition = amount + 1e-9 < request.minimumMolPerSecond ? 'minimum-curtailed' : amount + 1e-9 >= request.requestedMolPerSecond ? 'served' : 'capacity-curtailed';
      results.set(request.cavernId, { ...request, allocatedMolPerSecond: amount, curtailedMolPerSecond: Math.max(0, request.requestedMolPerSecond - amount), disposition });
    }
    const consumed = allocationTotal(allocations);
    remaining = Math.max(0, remaining - consumed);
  }
  return requests.map((item) => results.get(item.cavernId)!);
}
