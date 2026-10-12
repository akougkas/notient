import { refuse } from './paths.mjs';

export function unitVector(vector, dimension = vector?.length) {
  if (!Array.isArray(vector) && !(vector instanceof Float64Array)) refuse('VECTOR_INVALID', 'A numeric vector is required.');
  if (!Number.isInteger(dimension) || dimension < 1 || dimension > 8192 || vector.length !== dimension || ![...vector].every(Number.isFinite)) refuse('VECTOR_INVALID', 'Vector shape or values are invalid.');
  const maximum = Math.max(...vector.map(Math.abs));
  if (!(maximum > 0)) refuse('VECTOR_INVALID', 'A zero vector cannot be normalized.');
  const scaled = [...vector].map(value => value / maximum);
  const norm = Math.hypot(...scaled);
  return Float64Array.from(scaled, value => value / norm);
}

export function quantizeVector(vector, dimension = vector?.length) {
  const unit = unitVector(vector, dimension);
  const scale = Math.max(...unit.map(Math.abs)) / 127;
  const bytes = Buffer.alloc(dimension);
  for (let index = 0; index < dimension; index++) bytes.writeInt8(Math.max(-127, Math.min(127, Math.round(unit[index] / scale))), index);
  return { bytes, scale };
}

export function reconstructedVector(bytes, scale, dimension = bytes?.length) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== dimension || !Number.isInteger(dimension) || dimension < 1 || dimension > 8192 || !Number.isFinite(scale) || !(scale > 0)) refuse('VECTOR_INVALID', 'Quantized vector metadata is invalid.');
  const vector = Float64Array.from(bytes, value => (value > 127 ? value - 256 : value) * scale);
  if (![...vector].every(Number.isFinite) || !vector.some(value => value !== 0)) refuse('VECTOR_INVALID', 'Quantized vector has invalid reconstructed values.');
  return vector;
}

export function cosine(left, right) {
  const a = unitVector(left); const b = unitVector(right, a.length);
  let dot = 0; for (let index = 0; index < a.length; index++) dot += a[index] * b[index];
  return Math.max(-1, Math.min(1, dot));
}
