export type VitalTone = "freshness" | "health" | "connectivity" | "maturity";

export interface VitalMeterProps {
  tone: VitalTone;
  label: string;
  value: number | string;
  /** Suffix appended after a numeric display value (e.g. " links"). */
  suffix?: string;
  /** When true, the value is rendered as a category and no bar is shown. */
  isCategory?: boolean;
}

function clampPercent(percent: number): number {
  if (Number.isNaN(percent)) return 0;
  if (percent < 0) return 0;
  if (percent > 100) return 100;
  return Math.round(percent);
}

function fillFor(tone: VitalTone, value: number): number {
  if (tone === "connectivity") {
    return clampPercent((Math.min(value, 12) / 12) * 100);
  }
  return clampPercent(value * 100);
}

function displayFor(tone: VitalTone, value: number, suffix: string): string {
  if (tone === "connectivity") {
    return `${Math.round(value)}${suffix}`;
  }
  return `${Math.round(clampPercent(value * 100))}%${suffix}`;
}

export function VitalMeter({
  tone,
  label,
  value,
  suffix = "",
  isCategory = false,
}: VitalMeterProps) {
  if (isCategory || typeof value === "string") {
    const display = typeof value === "string" ? value : `${value}`;
    return (
      <div class="notient-vitals__cell" data-tone={tone}>
        <span class="notient-vitals__label">{label}</span>
        <span class="notient-vitals__value">{display}</span>
      </div>
    );
  }
  const numeric = value;
  const display = displayFor(tone, numeric, suffix);
  const fill = fillFor(tone, numeric);
  return (
    <div class="notient-vitals__cell" data-tone={tone}>
      <span class="notient-vitals__label">{label}</span>
      <span class="notient-vitals__value">{display}</span>
      <div class="notient-vitals__bar">
        <span style={`--notient-vitals-fill: ${fill}%`} />
      </div>
    </div>
  );
}
