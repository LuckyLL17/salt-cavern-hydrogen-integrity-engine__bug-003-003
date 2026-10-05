import type { FacilityRequest } from './request.ts';
export type RampAdjustedRequest = FacilityRequest & {
  nominalRequestMolPerSecond: number;
  nominalMinimumMolPerSecond: number;
  rampCurtailedMolPerSecond: number;
  rampReasons: string[];
};
const EPSILON = 1e-9;
export function applyRampBounds(requests: FacilityRequest[], horizonHours: number): RampAdjustedRequest[] {
  return requests.map((item) => {
    const previous = item.previousMolPerSecond ?? 0;
    const rate = item.rampMolPerSecondPerHour;
    const bounded = rate !== undefined && Number.isFinite(rate);
    const maximumRise = bounded ? rate * horizonHours : Infinity;
    const rampFloor = Math.max(0, previous - maximumRise);
    const rampCeiling = previous + maximumRise;
    const achievableTarget = Math.max(rampFloor, Math.min(item.requestedMolPerSecond, rampCeiling));
    const minimum = Math.min(achievableTarget, Math.max(item.minimumMolPerSecond, rampFloor));
    const rampReasons: string[] = [];
    if (achievableTarget + EPSILON < item.requestedMolPerSecond) rampReasons.push('ramp-ceiling-curtailed');
    if (achievableTarget > item.requestedMolPerSecond + EPSILON) rampReasons.push('ramp-floor-enforced');
    return {
      ...item,
      requestedMolPerSecond: achievableTarget,
      minimumMolPerSecond: minimum,
      nominalRequestMolPerSecond: item.requestedMolPerSecond,
      nominalMinimumMolPerSecond: item.minimumMolPerSecond,
      rampCurtailedMolPerSecond: Math.max(0, item.requestedMolPerSecond - achievableTarget),
      rampReasons,
    };
  });
}
