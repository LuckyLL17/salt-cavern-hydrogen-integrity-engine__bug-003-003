import { DomainError } from '../errors.ts';
export type FacilityRequest = {
  cavernId: string; requestedMolPerSecond: number; minimumMolPerSecond: number;
  priority: number; weight?: number; previousMolPerSecond?: number; rampMolPerSecondPerHour?: number;
};
export function validateRequests(requests: FacilityRequest[], capacity: number): FacilityRequest[] {
  if (!Number.isFinite(capacity) || capacity < 0) throw new DomainError('INVALID_STATION_CAPACITY', 'Station capacity must be finite and non-negative', 422);
  const ids = new Set<string>();
  return requests.map((item) => {
    if (!item || !item.cavernId.trim() || ids.has(item.cavernId)) throw new DomainError('DUPLICATE_CAVERN_REQUEST', 'Every cavern must have exactly one allocation request', 422, { cavernId: item?.cavernId });
    ids.add(item.cavernId);
    if (![item.requestedMolPerSecond, item.minimumMolPerSecond, item.priority].every(Number.isFinite) || item.requestedMolPerSecond < 0 || item.minimumMolPerSecond < 0 || item.minimumMolPerSecond > item.requestedMolPerSecond) throw new DomainError('INVALID_FACILITY_REQUEST', 'Request, minimum and priority values are inconsistent', 422, { item });
    const weight = item.weight ?? 1;
    const previous = item.previousMolPerSecond ?? 0;
    const ramp = item.rampMolPerSecondPerHour;
    if (!(weight > 0) || !Number.isFinite(weight)) throw new DomainError('INVALID_FACILITY_WEIGHT', 'Allocation weight must be finite and strictly positive', 422, { item });
    if (!Number.isFinite(previous) || previous < 0) throw new DomainError('INVALID_FACILITY_REQUEST', 'Previous-period flow must be finite and non-negative', 422, { item });
    if (ramp !== undefined && (!Number.isFinite(ramp) || ramp < 0)) throw new DomainError('INVALID_FACILITY_REQUEST', 'Ramp rate must be finite and non-negative', 422, { item });
    return { ...item, weight, previousMolPerSecond: previous };
  });
}
