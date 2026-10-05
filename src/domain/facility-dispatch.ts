export {
  allocateSharedCapacity,
  planSharedCapacity,
  type FacilityAllocation,
  type AllocationReport,
  type AllocationTotals,
  type PriorityBandReport,
  type AllocationReason,
  type AllocationDisposition,
} from './facility/allocator.ts';
export type { FacilityRequest } from './facility/request.ts';
export { rampWindows, type RampWindow } from './facility/ramp.ts';
export {
  priorityBands,
  resolveEffectivePlans,
  bandMinimumNeed,
  requiredMinimumFlow,
  type EffectivePlan,
} from './facility/priority-policy.ts';
