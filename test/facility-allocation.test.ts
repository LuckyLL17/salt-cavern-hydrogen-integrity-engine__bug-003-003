import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateSharedCapacity } from '../src/domain/facility/allocator.ts';
import { assessmentService } from '../src/application/assessment-service.ts';

test('water-filling redistributes leftover from capped requests iteratively', () => {
  const result = allocateSharedCapacity([
    { cavernId: 'small', requestedMolPerSecond: 2, minimumMolPerSecond: 0, priority: 1, weight: 1 },
    { cavernId: 'large', requestedMolPerSecond: 8, minimumMolPerSecond: 0, priority: 1, weight: 1 },
  ], 10);
  assert.deepEqual(result.map((item) => item.allocatedMolPerSecond), [2, 8]);
  assert.equal(result.reduce((sum, item) => sum + item.allocatedMolPerSecond, 0), 10);
  assert.ok(result.every((item) => item.disposition === 'served'));
});

test('minimum stable flows are served before weighted sharing of the remainder', () => {
  const result = allocateSharedCapacity([
    { cavernId: 'a', requestedMolPerSecond: 10, minimumMolPerSecond: 4, priority: 1, weight: 1 },
    { cavernId: 'b', requestedMolPerSecond: 10, minimumMolPerSecond: 2, priority: 1, weight: 1 },
  ], 8);
  assert.deepEqual(result.map((item) => item.allocatedMolPerSecond), [5, 3]);
  assert.ok(result.every((item) => item.disposition === 'capacity-curtailed'));
});

test('remaining capacity is split in proportion to request weights', () => {
  const result = allocateSharedCapacity([
    { cavernId: 'heavy', requestedMolPerSecond: 6, minimumMolPerSecond: 0, priority: 1, weight: 2 },
    { cavernId: 'light', requestedMolPerSecond: 6, minimumMolPerSecond: 0, priority: 1, weight: 1 },
  ], 9);
  assert.deepEqual(result.map((item) => item.allocatedMolPerSecond), [6, 3]);
});

test('an infeasible priority minimum is curtailed fairly within its own band and explained', () => {
  const result = allocateSharedCapacity([
    { cavernId: 'priority-a', requestedMolPerSecond: 10, minimumMolPerSecond: 6, priority: 2, weight: 1 },
    { cavernId: 'priority-b', requestedMolPerSecond: 10, minimumMolPerSecond: 6, priority: 2, weight: 1 },
    { cavernId: 'priority-c', requestedMolPerSecond: 8, minimumMolPerSecond: 1, priority: 1, weight: 1 },
  ], 8);
  assert.deepEqual(result.map((item) => item.allocatedMolPerSecond), [4, 4, 0]);
  assert.equal(result[0].disposition, 'minimum-curtailed');
  assert.ok(result[0].reasons.includes('band-minimum-infeasible'));
  assert.ok(result[0].reasons.includes('minimum-curtailed'));
  assert.ok(result[1].reasons.includes('band-minimum-infeasible'));
  assert.equal(result[2].disposition, 'minimum-curtailed');
  assert.ok(result[2].reasons.includes('priority-capacity-exhausted'));
});

test('a lower priority band never preempts capacity usable by a higher band', () => {
  const result = allocateSharedCapacity([
    { cavernId: 'high', requestedMolPerSecond: 10, minimumMolPerSecond: 6, priority: 2 },
    { cavernId: 'low', requestedMolPerSecond: 10, minimumMolPerSecond: 6, priority: 1 },
  ], 8);
  assert.equal(result[0].allocatedMolPerSecond, 8);
  assert.equal(result[0].disposition, 'capacity-curtailed');
  assert.equal(result[1].allocatedMolPerSecond, 0);
  assert.equal(result[1].disposition, 'minimum-curtailed');
  const surplus = allocateSharedCapacity([
    { cavernId: 'high', requestedMolPerSecond: 5, minimumMolPerSecond: 1, priority: 2 },
    { cavernId: 'low', requestedMolPerSecond: 5, minimumMolPerSecond: 1, priority: 1 },
  ], 8);
  assert.deepEqual(surplus.map((item) => item.allocatedMolPerSecond), [5, 3]);
});

test('ramp ceiling curtailment stays visible across periods and conserves the request', () => {
  const [item] = allocateSharedCapacity([
    { cavernId: 'ramped', requestedMolPerSecond: 10, minimumMolPerSecond: 1, priority: 1, previousMolPerSecond: 0, rampMolPerSecondPerHour: 2 },
  ], 100, 1);
  assert.equal(item.allocatedMolPerSecond, 2);
  assert.equal(item.disposition, 'served');
  assert.equal(item.requestedMolPerSecond, 10);
  assert.equal(item.rampAdjustedRequestMolPerSecond, 2);
  assert.equal(item.rampCurtailedMolPerSecond, 8);
  assert.ok(item.reasons.includes('ramp-ceiling-curtailed'));
  assert.ok(Math.abs(item.allocatedMolPerSecond + item.curtailedMolPerSecond + item.rampCurtailedMolPerSecond - item.requestedMolPerSecond) < 1e-9);
});

test('ramp floor forces a minimum offtake and is explained', () => {
  const [item] = allocateSharedCapacity([
    { cavernId: 'steep', requestedMolPerSecond: 2, minimumMolPerSecond: 0, priority: 1, previousMolPerSecond: 10, rampMolPerSecondPerHour: 3 },
  ], 100, 1);
  assert.equal(item.allocatedMolPerSecond, 7);
  assert.equal(item.rampAdjustedRequestMolPerSecond, 7);
  assert.equal(item.rampAdjustedMinimumMolPerSecond, 7);
  assert.equal(item.requestedMolPerSecond, 2);
  assert.ok(item.reasons.includes('ramp-floor-enforced'));
});

test('a zero horizon freezes flow at the previous setpoint without NaN leakage', () => {
  const [frozen] = allocateSharedCapacity([
    { cavernId: 'frozen', requestedMolPerSecond: 10, minimumMolPerSecond: 1, priority: 1, previousMolPerSecond: 4, rampMolPerSecondPerHour: 2 },
  ], 100, 0);
  assert.equal(frozen.allocatedMolPerSecond, 4);
  const [unbounded] = allocateSharedCapacity([
    { cavernId: 'unbounded', requestedMolPerSecond: 5, minimumMolPerSecond: 1, priority: 1 },
  ], 10, 0);
  assert.equal(unbounded.allocatedMolPerSecond, 5);
  assert.ok(Number.isFinite(unbounded.allocatedMolPerSecond));
});

test('facility summary reconciles allocated, curtailed and station capacity', () => {
  const summary = assessmentService.facility([
    { cavernId: 'a', requestedMolPerSecond: 10, minimumMolPerSecond: 6, priority: 2, weight: 1 },
    { cavernId: 'b', requestedMolPerSecond: 10, minimumMolPerSecond: 6, priority: 2, weight: 1 },
    { cavernId: 'c', requestedMolPerSecond: 8, minimumMolPerSecond: 1, priority: 1, weight: 1 },
  ], 8);
  assert.equal(summary.allocatedMolPerSecond, 8);
  assert.equal(summary.unallocatedMolPerSecond, 0);
  assert.equal(summary.allocatedMolPerSecond + summary.unallocatedMolPerSecond, summary.stationCapacityMolPerSecond);
  assert.ok(Math.abs(summary.requestedMolPerSecond - summary.allocatedMolPerSecond - summary.curtailedMolPerSecond - summary.rampCurtailedMolPerSecond) < 1e-9);
  for (const item of summary.allocations) {
    assert.ok(item.allocatedMolPerSecond >= 0 && item.allocatedMolPerSecond <= item.rampAdjustedRequestMolPerSecond + 1e-9);
    assert.ok(Math.abs(item.allocatedMolPerSecond + item.curtailedMolPerSecond - item.rampAdjustedRequestMolPerSecond) < 1e-9);
  }
});
