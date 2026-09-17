/**
 * SurrealDB SCHEMAFULL tables cannot declare an unconstrained `any` field.
 * Heterogeneous values are stored inside one flexible object field instead of
 * being JSON-encoded. This keeps the database value typed and makes malformed
 * rows fail closed at the persistence boundary.
 */

export interface NativeValueEnvelope {
  data: unknown;
}

export function wrapNativeValue(value: unknown): NativeValueEnvelope {
  return { data: value };
}

export function unwrapNativeValue(value: unknown, source: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${source}: expected a native value envelope`);
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "data") {
    throw new Error(`${source}: expected the canonical { data } native value envelope`);
  }
  return (value as Record<string, unknown>).data;
}
