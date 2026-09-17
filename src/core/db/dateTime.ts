import { DateTime } from "surrealdb";

/** Decode only the native datetime shape returned by SurrealDB 3.x. */
export function nativeDateTimeToEpochMillis(value: unknown): number | null {
  if (!(value instanceof DateTime)) return null;
  const milliseconds = value.toDate().getTime();
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds : null;
}
