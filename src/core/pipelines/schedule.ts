import type { PipelinePolicy } from "../../api/operations";

/** Operating windows are evaluated in the configured IANA zone, including DST. */
export function insideOperatingWindow(policy: PipelinePolicy, at: number): boolean {
  if (!policy.windows.length) return true;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: policy.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(part("weekday"));
  const minute = Number(part("hour")) * 60 + Number(part("minute"));
  return policy.windows.some(
    (window) =>
      window.days.includes(day) && minute >= window.startMinute && minute < window.endMinute,
  );
}
export function nextOperatingTime(policy: PipelinePolicy, earliest: number): number | null {
  if (insideOperatingWindow(policy, earliest)) return earliest;
  // Bound search to a complete weekly schedule plus DST transitions.
  for (let minute = 1; minute <= 8 * 24 * 60; minute++) {
    const at = Math.ceil(earliest / 60000) * 60000 + minute * 60000;
    if (insideOperatingWindow(policy, at)) return at;
  }
  return null;
}
