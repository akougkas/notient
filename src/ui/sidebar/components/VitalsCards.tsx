/**
 * VitalsCards - Four metric cards showing note health (Section 2 of Note Vitals)
 *
 * Per spec layout:
 * ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
 * │  heart │ │  link  │ │calendar│ │  chart │
 * │  85%   │ │   12   │ │   3d   │ │   A    │
 * │ Health │ │ Links  │ │ Fresh  │ │ Grade  │
 * └────────┘ └────────┘ └────────┘ └────────┘
 *
 * Each card is clickable and sends the user to chat for more details.
 */

import { setIcon } from "obsidian";
import { useEffect, useRef } from "preact/hooks";
import type { NoteVitals } from "../../../services/noteVitalsCalculator";

interface VitalsCardsProps {
  vitals: NoteVitals;
  onCardClick?: (metric: "health" | "links" | "freshness" | "grade") => void;
}

type VitalStatus = "healthy" | "attention" | "unhealthy";

// Icon component for Lucide icons in Preact
function Icon({ name, className }: { name: string; className?: string }) {
  const iconRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (iconRef.current) {
      setIcon(iconRef.current, name);
    }
  }, [name]);
  return <span ref={iconRef} class={className} aria-hidden="true" />;
}

export function VitalsCards({ vitals, onCardClick }: VitalsCardsProps) {
  const grade = calculateGrade(vitals);
  const totalLinks = vitals.links.backlinks + vitals.links.outlinks;
  const freshnessStatus = getFreshnessStatus(vitals.freshness.lastModified);

  // Calculate health status message - issues may not exist on health type
  const healthIssues = (vitals.health as { issues?: string[] }).issues || [];
  const healthHint =
    healthIssues.length > 0 ? `Issues: ${healthIssues.slice(0, 2).join(", ")}` : "Good health";

  // Generate health summary message per spec
  const healthSummary = generateHealthSummary(vitals.health.score, healthIssues);

  return (
    <section class="nv2-vitals-section" aria-label="Note vitals">
      <div class="nv2-vitals-cards">
        <VitalCard
          metric="health"
          icon="heart"
          value={`${vitals.health.score}%`}
          label="Health"
          status={vitals.health.status}
          hint={healthHint}
          onClick={() => onCardClick?.("health")}
        />
        <VitalCard
          metric="links"
          icon="link"
          value={formatLinkCount(totalLinks)}
          label="Links"
          status={getLinkStatus(totalLinks)}
          hint={`${vitals.links.backlinks} in / ${vitals.links.outlinks} out`}
          onClick={() => onCardClick?.("links")}
        />
        <VitalCard
          metric="freshness"
          icon="calendar"
          value={vitals.freshness.displayText}
          label="Fresh"
          status={freshnessStatus}
          hint={formatLastModified(vitals.freshness.lastModified)}
          onClick={() => onCardClick?.("freshness")}
        />
        <VitalCard
          metric="grade"
          icon="bar-chart-2"
          value={grade}
          label="Grade"
          status={getGradeStatus(grade)}
          hint={getGradeHint(grade)}
          onClick={() => onCardClick?.("grade")}
        />
      </div>
      {/* Health summary message below cards - per spec */}
      <div class={`nv2-vitals-summary nv2-vitals-summary--${vitals.health.status}`}>
        <span class="nv2-vitals-summary-label">Health:</span>
        <span class="nv2-vitals-summary-text">{healthSummary}</span>
      </div>
    </section>
  );
}

interface VitalCardProps {
  metric: "health" | "links" | "freshness" | "grade";
  icon: string;
  value: string;
  label: string;
  status: VitalStatus;
  hint: string;
  onClick?: () => void;
}

function VitalCard({ metric, icon, value, label, status, hint, onClick }: VitalCardProps) {
  return (
    <button
      type="button"
      class={`nv2-vital-card nv2-vital-card--${status}`}
      onClick={onClick}
      title={`${label}: ${value}\n${hint}`}
      aria-label={`${label}: ${value}. ${hint}. Click for details.`}
      data-metric={metric}
    >
      <Icon name={icon} className="nv2-vital-icon" />
      <span class="nv2-vital-value">{value}</span>
      <span class="nv2-vital-label">{label}</span>
      <span class="nv2-vital-ring" />
    </button>
  );
}

// Grade calculation
function calculateGrade(vitals: NoteVitals): "A" | "B" | "C" | "D" | "F" {
  const healthScore = vitals.health.score;
  const totalLinks = vitals.links.backlinks + vitals.links.outlinks;
  const hasTags = vitals.tags.length > 0;

  let points = 0;
  if (healthScore >= 80) points += 3;
  else if (healthScore >= 60) points += 2;
  else if (healthScore >= 40) points += 1;

  if (totalLinks >= 5) points += 2;
  else if (totalLinks >= 2) points += 1;

  if (hasTags) points += 1;

  if (points >= 5) return "A";
  if (points >= 4) return "B";
  if (points >= 3) return "C";
  if (points >= 2) return "D";
  return "F";
}

// Status helpers
function getLinkStatus(count: number): VitalStatus {
  if (count >= 5) return "healthy";
  if (count > 0) return "attention";
  return "unhealthy";
}

function getFreshnessStatus(lastModified: Date): VitalStatus {
  const daysSince = Math.floor((Date.now() - lastModified.getTime()) / (1000 * 60 * 60 * 24));
  if (daysSince <= 7) return "healthy";
  if (daysSince <= 30) return "attention";
  return "unhealthy";
}

function getGradeStatus(grade: string): VitalStatus {
  if (grade === "A" || grade === "B") return "healthy";
  if (grade === "C") return "attention";
  return "unhealthy";
}

// Formatting helpers
function formatLinkCount(count: number): string {
  return String(count);
}

function formatLastModified(date: Date): string {
  return `Last edited: ${date.toLocaleDateString()}`;
}

function getGradeHint(grade: string): string {
  const hints: Record<string, string> = {
    A: "Excellent quality",
    B: "Good quality",
    C: "Needs attention",
    D: "Needs improvement",
    F: "Requires work",
  };
  return hints[grade] || "Unknown";
}

// Generate human-readable health summary
function generateHealthSummary(score: number, issues: string[]): string {
  if (score >= 80 && issues.length === 0) {
    return "Good structure, well-connected";
  }
  if (score >= 80) {
    return `Good structure, ${issues[0]}`;
  }
  if (score >= 60) {
    if (issues.length === 0) return "Decent structure, could use more links";
    return issues.slice(0, 2).join(", ");
  }
  if (issues.length === 0) return "Needs improvement";
  return issues.slice(0, 2).join(", ");
}
