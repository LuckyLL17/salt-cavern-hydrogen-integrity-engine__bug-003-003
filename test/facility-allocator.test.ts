import test from 'node:test';
import assert from 'node:assert/strict';
import { planSharedCapacity, allocateSharedCapacity } from '../src/domain/facility/allocator.ts';
import { rampWindowFor } from '../src/domain/facility/ramp.ts';

const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

test('higher priority is served in full before a lower priority receives anything', () => {
  const report = planSharedCapacity([
    { cavernId: 'hi', requestedMolPerSecond: 8, minimumMolPerSecond: 1, priority: 2 },
    { cavernId: 'lo', requestedMolPerSecond: 8, minimumMolPerSecond: 1, priority: 1 },
  ], 10);
  const [hi, lo] = report.allocations;
  assert.equal(hi.allocatedMolPerSecond, 8);
  assert.equal(lo.allocatedMolPerSecond, 2);
  assert.equal(lo.disposition, 'capacity-curtailed');
  assert.equal(report.bands[0].phase, 'minimums-first-weighted-waterfill');
  assert.equal(report.bands[0].residualCapacityMolPerSecond, 2);
  assert.equal(report.bands[1].drawnFromPoolMolPerSecond, 2);
  assert.equal(report.bands[1].minimumFeasible, true);
  assert.equal(report.bands[1].residualCapacityMolPerSecond, 0);
});

test('infeasible minimums are cut fairly inside the priority and the reason is recorded per cavern', () => {
  const report = planSharedCapacity([
    { cavernId: 'a', requestedMolPerSecond: 10, minimumMolPerSecond: 6, priority: 2, weight: 1 },
    { cavernId: 'b', requestedMolPerSecond: 10, minimumMolPerSecond: 6, priority: 2, weight: 1 },
    { cavernId: 'c', requestedMolPerSecond: 8, minimumMolPerSecond: 1, priority: 1, weight: 1 },
  ], 8);
  assert.deepEqual(report.allocations.map((x) => x.allocatedMolPerSecond), [4, 4, 0]);
  assert.ok(report.allocations[0].reasons.includes('minimum-curtailed-pro-rata'));
  assert.ok(approx(report.bands[0].minimumSatisfactionFraction, 8 / 12));
  assert.equal(report.bands[0].minimumFeasible, false);
  assert.equal(report.bands[1].phase, 'preempted');
  assert.equal(report.bands[1].drawnFromPoolMolPerSecond, 0);
  assert.equal(report.bands[1].residualCapacityMolPerSecond, 0);
});

test('the fair minimum cut ignores weights; weights only govern surplus above minimums', () => {
  const cut = planSharedCapacity([
    { cavernId: 'a', requestedMolPerSecond: 10, minimumMolPerSecond: 6, priority: 1, weight: 9 },
    { cavernId: 'b', requestedMolPerSecond: 10, minimumMolPerSecond: 6, priority: 1, weight: 1 },
  ], 6);
  assert.ok(approx(cut.allocations[0].allocatedMolPerSecond, 3));
  assert.ok(approx(cut.allocations[1].allocatedMolPerSecond, 3));

  const surplus = planSharedCapacity([
    { cavernId: 'a', requestedMolPerSecond: 10, minimumMolPerSecond: 2, priority: 1, weight: 1 },
    { cavernId: 'b', requestedMolPerSecond: 10, minimumMolPerSecond: 2, priority: 1, weight: 3 },
  ], 8);
  assert.ok(approx(surplus.allocations[0].allocatedMolPerSecond, 3));
  assert.ok(approx(surplus.allocations[1].allocatedMolPerSecond, 5));
});

test('weighted water fill iterates so an early cap releases capacity instead of stranding it', () => {
  const report = planSharedCapacity([
    { cavernId: 'big', requestedMolPerSecond: 10, minimumMolPerSecond: 0, priority: 1, weight: 1 },
    { cavernId: 'mid', requestedMolPerSecond: 3, minimumMolPerSecond: 0, priority: 1, weight: 1 },
    { cavernId: 'small', requestedMolPerSecond: 2, minimumMolPerSecond: 0, priority: 1, weight: 1 },
  ], 8);
  assert.deepEqual(report.allocations.map((a) => a.allocatedMolPerSecond), [3, 3, 2]);
  assert.equal(report.totals.unusedCapacityMolPerSecond, 0);
});

test('a middle-priority band never receives capacity needed by a higher-priority minimum', () => {
  const report = planSharedCapacity([
    { cavernId: 'top1', requestedMolPerSecond: 10, minimumMolPerSecond: 5, priority: 3 },
    { cavernId: 'top2', requestedMolPerSecond: 10, minimumMolPerSecond: 5, priority: 3 },
    { cavernId: 'mid', requestedMolPerSecond: 10, minimumMolPerSecond: 4, priority: 2 },
    { cavernId: 'low', requestedMolPerSecond: 10, minimumMolPerSecond: 0, priority: 1 },
  ], 8);
  assert.deepEqual(report.allocations.map((a) => a.allocatedMolPerSecond), [4, 4, 0, 0]);
  assert.equal(report.allocations[2].disposition, 'minimum-curtailed');
  assert.ok(report.allocations[2].reasons.includes('preempted-by-higher-priority'));
  assert.deepEqual(report.bands.map((b) => b.phase), ['minimums-pro-rata', 'preempted', 'preempted']);
});

test('a lower priority shares the surplus after higher priorities are fully satisfied', () => {
  const report = planSharedCapacity([
    { cavernId: 'top', requestedMolPerSecond: 4, minimumMolPerSecond: 4, priority: 2 },
    { cavernId: 'lo1', requestedMolPerSecond: 10, minimumMolPerSecond: 0, priority: 1, weight: 1 },
    { cavernId: 'lo2', requestedMolPerSecond: 10, minimumMolPerSecond: 0, priority: 1, weight: 1 },
  ], 10);
  assert.equal(report.allocations[0].allocatedMolPerSecond, 4);
  assert.ok(approx(report.allocations[1].allocatedMolPerSecond, 3));
  assert.ok(approx(report.allocations[2].allocatedMolPerSecond, 3));
});

test('the up-ramp ceiling caps the achievable request and attributes the curtailment', () => {
  const report = planSharedCapacity([
    { cavernId: 'a', requestedMolPerSecond: 10, minimumMolPerSecond: 0, priority: 1, previousMolPerSecond: 2, rampMolPerSecondPerHour: 3 },
  ], 20, 1);
  const a = report.allocations[0];
  assert.equal(a.allocatedMolPerSecond, 5);
  assert.equal(a.rampLimitedMolPerSecond, 5);
  assert.equal(a.capacityCurtailedMolPerSecond, 0);
  assert.equal(a.disposition, 'served');
  assert.ok(a.reasons.includes('ramp-up-limited'));
  assert.equal(a.rampChangeMolPerSecond, 3);
});

test('a down-ramp floor is a physical lower bound honoured before priority competition', () => {
  const report = planSharedCapacity([
    { cavernId: 'hi', requestedMolPerSecond: 10, minimumMolPerSecond: 0, priority: 2 },
    { cavernId: 'lo', requestedMolPerSecond: 1, minimumMolPerSecond: 0, priority: 1, previousMolPerSecond: 4, rampMolPerSecondPerHour: 1 },
  ], 10);
  const lo = report.allocations.find((a) => a.cavernId === 'lo')!;
  assert.equal(lo.allocatedMolPerSecond, 3);
  assert.ok(lo.reasons.includes('ramp-down-forced'));
  assert.equal(lo.rampChangeMolPerSecond, -1);
  // The floor consumed 3 units of capacity before the high-priority band competed for the rest.
  assert.equal(report.bands[0].capacityAvailableMolPerSecond, 7);
});

test('flow forced above the request by a slow down-ramp is reported as forced surplus, never negative curtailment', () => {
  const report = planSharedCapacity([
    { cavernId: 'a', requestedMolPerSecond: 4.79, minimumMolPerSecond: 2.7, priority: 1, previousMolPerSecond: 9.87, rampMolPerSecondPerHour: 0.87 },
  ], 100, 0.05);
  const a = report.allocations[0];
  assert.ok(approx(a.rampFloorMolPerSecond, 9.8265));
  assert.equal(a.allocatedMolPerSecond, 9.8265);
  assert.equal(a.curtailedMolPerSecond, 0);
  assert.ok(approx(a.forcedSurplusMolPerSecond, 9.8265 - 4.79));
  assert.ok(a.reasons.includes('ramp-down-forced'));
  assert.ok(approx(a.deviationMolPerSecond, 9.8265 - 4.79));
});

test('a zero horizon freezes flow and classifies the unmet request as up-ramp limited', () => {
  const report = planSharedCapacity([
    { cavernId: 'a', requestedMolPerSecond: 10, minimumMolPerSecond: 0, priority: 1, previousMolPerSecond: 3, rampMolPerSecondPerHour: 2 },
  ], 50, 0);
  const a = report.allocations[0];
  assert.equal(a.allocatedMolPerSecond, 3);
  assert.equal(a.rampChangeMolPerSecond, 0);
  assert.equal(a.rampLimitedMolPerSecond, 7);
  assert.equal(a.disposition, 'served');
  assert.ok(a.reasons.includes('ramp-up-limited'));
});

test('a missing ramp rate means an unlimited ramp window regardless of horizon', () => {
  const window = rampWindowFor({ cavernId: 'a', requestedMolPerSecond: 10, minimumMolPerSecond: 0, priority: 1, previousMolPerSecond: 2 }, 0);
  assert.equal(window.floorMolPerSecond, 0);
  assert.equal(window.ceilingMolPerSecond, Infinity);
  const report = planSharedCapacity([
    { cavernId: 'a', requestedMolPerSecond: 10, minimumMolPerSecond: 0, priority: 1, previousMolPerSecond: 2 },
  ], 50, 0);
  assert.equal(report.allocations[0].allocatedMolPerSecond, 10);
});

test('forced floors exceeding station capacity produce an explicit overflow instead of hidden violations', () => {
  const report = planSharedCapacity([
    { cavernId: 'a', requestedMolPerSecond: 5, minimumMolPerSecond: 0, priority: 2, previousMolPerSecond: 8, rampMolPerSecondPerHour: 1 },
    { cavernId: 'b', requestedMolPerSecond: 5, minimumMolPerSecond: 0, priority: 1, previousMolPerSecond: 8, rampMolPerSecondPerHour: 1 },
  ], 10, 1);
  assert.equal(report.totals.forcedRampFloorMolPerSecond, 14);
  assert.equal(report.totals.forcedFloorOverflowMolPerSecond, 4);
  assert.ok(approx(report.totals.allocatedMolPerSecond - report.totals.forcedFloorOverflowMolPerSecond, 10));
  assert.ok(report.allocations.every((a) => a.reasons.includes('forced-ramp-floor-exceeds-capacity')));
  assert.deepEqual(report.allocations.map((a) => a.allocatedMolPerSecond), [7, 7]);
});

test('every row conserves: allocated = requested - curtailed + forced surplus', () => {
  const report = planSharedCapacity([
    { cavernId: 'a', requestedMolPerSecond: 9, minimumMolPerSecond: 2, priority: 2, weight: 1, previousMolPerSecond: 1, rampMolPerSecondPerHour: 4 },
    { cavernId: 'b', requestedMolPerSecond: 7, minimumMolPerSecond: 3, priority: 2, weight: 3, previousMolPerSecond: 6, rampMolPerSecondPerHour: 2 },
    { cavernId: 'c', requestedMolPerSecond: 6, minimumMolPerSecond: 1, priority: 1, weight: 2 },
  ], 12, 1);
  for (const a of report.allocations) {
    assert.ok(approx(a.allocatedMolPerSecond, a.requestedMolPerSecond - a.curtailedMolPerSecond + a.forcedSurplusMolPerSecond));
    assert.ok(approx(a.rampLimitedMolPerSecond + a.capacityCurtailedMolPerSecond, a.curtailedMolPerSecond));
    assert.ok(approx(a.deviationMolPerSecond, a.forcedSurplusMolPerSecond - a.curtailedMolPerSecond));
    assert.ok(!(a.curtailedMolPerSecond > 0 && a.forcedSurplusMolPerSecond > 0));
    assert.ok(a.allocatedMolPerSecond >= a.rampFloorMolPerSecond - 1e-9);
    assert.ok(a.allocatedMolPerSecond <= a.rampCeilingMolPerSecond + 1e-9);
    assert.ok(approx(a.rampChangeMolPerSecond, a.allocatedMolPerSecond - a.previousMolPerSecond));
  }
  const allocated = report.allocations.reduce((sum, a) => sum + a.allocatedMolPerSecond, 0);
  assert.ok(allocated <= 12 + 1e-9);
  assert.ok(approx(allocated + report.totals.unusedCapacityMolPerSecond, 12));
});

test('the per-band ledger chains capacity entry, floors, pool draw and residual without gaps', () => {
  const report = planSharedCapacity([
    { cavernId: 'a', requestedMolPerSecond: 6, minimumMolPerSecond: 1, priority: 3 },
    { cavernId: 'b', requestedMolPerSecond: 6, minimumMolPerSecond: 1, priority: 2, previousMolPerSecond: 4, rampMolPerSecondPerHour: 1 },
    { cavernId: 'c', requestedMolPerSecond: 6, minimumMolPerSecond: 1, priority: 1 },
  ], 10);
  const totalFloors = report.totals.forcedRampFloorMolPerSecond;
  let carry = 10 - totalFloors;
  for (const band of report.bands) {
    assert.ok(approx(band.capacityAvailableMolPerSecond, carry));
    assert.ok(approx(band.forcedFloorMolPerSecond + band.drawnFromPoolMolPerSecond, band.consumedMolPerSecond));
    assert.ok(approx(band.residualCapacityMolPerSecond, band.capacityAvailableMolPerSecond - band.drawnFromPoolMolPerSecond));
    carry = band.residualCapacityMolPerSecond;
  }
  const bandFloors = report.bands.reduce((sum, b) => sum + b.forcedFloorMolPerSecond, 0);
  const bandDraws = report.bands.reduce((sum, b) => sum + b.drawnFromPoolMolPerSecond, 0);
  assert.ok(approx(bandFloors, totalFloors));
  assert.ok(approx(bandFloors + bandDraws, report.totals.allocatedMolPerSecond));
});

test('randomised instances always conserve capacity, ramp windows and ledgers', () => {
  let seed = 987654321;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let trial = 0; trial < 2000; trial++) {
    const n = 1 + Math.floor(rand() * 5);
    const requests = Array.from({ length: n }, (_unused, i) => {
      const requested = Math.round(rand() * 20 * 100) / 100;
      const ramp = rand() < 0.5 ? undefined : Math.round(rand() * 8 * 100) / 100;
      return {
        cavernId: `c${i}`,
        requestedMolPerSecond: requested,
        minimumMolPerSecond: Math.round(rand() * requested * 100) / 100,
        priority: 1 + Math.floor(rand() * 3),
        weight: 0.1 + rand() * 5,
        previousMolPerSecond: Math.round(rand() * 16 * 100) / 100,
        ...(ramp === undefined ? {} : { rampMolPerSecondPerHour: ramp }),
      };
    });
    const capacity = Math.round(rand() * 45 * 100) / 100;
    const horizon = Math.round(rand() * 3 * 100) / 100;
    const report = planSharedCapacity(requests, capacity, horizon);
    let sumAllocated = 0;
    for (const a of report.allocations) {
      assert.ok(approx(a.allocatedMolPerSecond, a.requestedMolPerSecond - a.curtailedMolPerSecond + a.forcedSurplusMolPerSecond, 1e-6), `row ${trial}`);
      assert.ok(approx(a.rampLimitedMolPerSecond + a.capacityCurtailedMolPerSecond, a.curtailedMolPerSecond, 1e-6), `split ${trial}`);
      assert.ok(a.allocatedMolPerSecond >= a.rampFloorMolPerSecond - 1e-7, `floor ${trial}`);
      assert.ok(a.allocatedMolPerSecond <= a.rampCeilingMolPerSecond + 1e-7, `ceiling ${trial}`);
      if (a.rampMolPerSecondPerHour !== undefined) {
        const span = a.rampMolPerSecondPerHour * horizon;
        assert.ok(a.rampChangeMolPerSecond >= -span - 1e-7 && a.rampChangeMolPerSecond <= span + 1e-7, `span ${trial}`);
      }
      sumAllocated += a.allocatedMolPerSecond;
    }
    if (report.totals.forcedFloorOverflowMolPerSecond <= 1e-7) {
      assert.ok(sumAllocated <= capacity + 1e-6, `cap ${trial}`);
      assert.ok(approx(sumAllocated + report.totals.unusedCapacityMolPerSecond, capacity, 1e-6), `unused ${trial}`);
    }
    let carry = Math.max(0, capacity - report.totals.forcedRampFloorMolPerSecond);
    for (const band of report.bands) {
      assert.ok(approx(band.capacityAvailableMolPerSecond, carry, 1e-6), `entry ${trial}`);
      assert.ok(approx(band.residualCapacityMolPerSecond, band.capacityAvailableMolPerSecond - band.drawnFromPoolMolPerSecond, 1e-6), `residual ${trial}`);
      if (band.phase === 'preempted') assert.equal(band.drawnFromPoolMolPerSecond, 0);
      carry = band.residualCapacityMolPerSecond;
    }
  }
});

test('the flat compatibility API returns one ordered row per request', () => {
  const rows = allocateSharedCapacity([
    { cavernId: 'x', requestedMolPerSecond: 5, minimumMolPerSecond: 0, priority: 1 },
    { cavernId: 'y', requestedMolPerSecond: 5, minimumMolPerSecond: 0, priority: 1 },
  ], 6);
  assert.deepEqual(rows.map((r) => r.cavernId), ['x', 'y']);
  assert.ok(approx(rows[0].allocatedMolPerSecond + rows[1].allocatedMolPerSecond, 6));
});
