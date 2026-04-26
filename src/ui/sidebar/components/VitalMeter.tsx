export interface VitalMeterProps {
  label: string;
  value: number;
  display: string;
}

export function VitalMeter({ label, value, display }: VitalMeterProps) {
  const clamped = Math.max(0, Math.min(1, value));
  const percent = Math.round(clamped * 100);
  return (
    <div class="notient-vital">
      <div class="notient-vital__label">{label}</div>
      <div
        class="notient-vital__bar"
        role="progressbar"
        tabIndex={0}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div class="notient-vital__fill" style={`width:${percent}%`} />
      </div>
      <div class="notient-vital__value">{display}</div>
    </div>
  );
}
