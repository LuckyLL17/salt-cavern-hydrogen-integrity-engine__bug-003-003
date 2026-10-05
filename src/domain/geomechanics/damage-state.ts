import { DomainError } from '../errors.ts';
import { creepRate, type CreepParameters } from './creep-law.ts';
export type GeoState = { cumulativeDamage: number; creepStrain: number; elapsedHours: number; lastPressureKpa: number; loadingDirection: -1 | 0 | 1; peakPressureKpa: number };
export type GeoParameters = CreepParameters & { recoveryPerHour: number; maxDamage: number; strainPerDamage?: number };
export type GeoInterval = { durationHours: number; pressureKpa: number; temperatureK: number; pressureStartKpa?: number; pressureEndKpa?: number; temperatureStartK?: number; temperatureEndK?: number; resting: boolean; label?: string };
export function initialGeoState(): GeoState { return { cumulativeDamage: 0, creepStrain: 0, elapsedHours: 0, lastPressureKpa: 0, loadingDirection: 0, peakPressureKpa: 0 }; }

export function advanceGeoState(state: GeoState, interval: GeoInterval, parameters: GeoParameters): GeoState {
  if (!(interval.durationHours > 0) || !Number.isFinite(interval.durationHours)) throw new DomainError('INVALID_GEO_INTERVAL', 'Geomechanical interval duration must be positive', 422, { interval });
  const pressureStart = interval.pressureStartKpa ?? state.lastPressureKpa;
  const pressureEnd = interval.pressureEndKpa ?? interval.pressureKpa;
  const temperatureStart = interval.temperatureStartK ?? interval.temperatureK;
  const temperatureEnd = interval.temperatureEndK ?? interval.temperatureK;
  if ([pressureStart, pressureEnd].some((value) => !Number.isFinite(value) || value < 0) || [temperatureStart, temperatureEnd].some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new DomainError('INVALID_GEO_INTERVAL', 'Geomechanical path endpoints must be physically valid', 422, { interval });
  }
  const slices = Math.max(1, Math.ceil(interval.durationHours / 2));
  const dt = interval.durationHours / slices;
  let damage = state.cumulativeDamage;
  let strain = state.creepStrain;
  let previousPressure = pressureStart;
  let peakPressure = state.peakPressureKpa;
  let loadingDirection = state.loadingDirection;
  const strainPerDamage = parameters.strainPerDamage ?? 1e-5;
  for (let index = 0; index < slices; index += 1) {
    const left = index / slices;
    const right = (index + 1) / slices;
    const pressure = pressureStart + (pressureEnd - pressureStart) * (left + right) / 2;
    const temperature = temperatureStart + (temperatureEnd - temperatureStart) * (left + right) / 2;
    const direction: -1 | 0 | 1 = pressure > previousPressure ? 1 : pressure < previousPressure ? -1 : 0;
    const increment = creepRate(pressure, temperature, parameters) * dt;
    const recovered = interval.resting ? damage * (1 - Math.exp(-parameters.recoveryPerHour * dt)) : 0;
    damage = Math.min(parameters.maxDamage, Math.max(0, damage + increment - recovered));
    strain += increment * strainPerDamage;
    if (direction !== 0) loadingDirection = direction;
    previousPressure = pressure;
    peakPressure = Math.max(peakPressure, pressure);
  }
  return { cumulativeDamage: damage, creepStrain: strain, elapsedHours: state.elapsedHours + interval.durationHours, lastPressureKpa: pressureEnd, loadingDirection, peakPressureKpa: peakPressure };
}
