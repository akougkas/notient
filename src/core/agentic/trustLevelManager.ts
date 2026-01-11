/**
 * Trust Level Manager
 *
 * Evaluates proposed actions against trust policy to determine
 * whether they can be auto-applied or require user confirmation.
 */

import type { TrustPolicy } from "../../types/settings";
import type { ProposedAction, RiskLevel, TrustDecision } from "./types";

/**
 * Default trust policy (conservative)
 */
const DEFAULT_TRUST_POLICY: TrustPolicy = {
  autoApplyLowRisk: false,
  requireConfirmMediumRisk: true,
  requireConfirmHighRisk: true,
};

/**
 * Manages trust evaluation for proposed actions
 */
export class TrustLevelManager {
  private policy: TrustPolicy;

  constructor(policy?: TrustPolicy) {
    this.policy = policy ?? { ...DEFAULT_TRUST_POLICY };
  }

  /**
   * Evaluate an action against the trust policy
   * @param action - The proposed action to evaluate
   * @param hasWriteLock - Whether the plugin currently holds the write lock
   */
  evaluate(action: ProposedAction, hasWriteLock = true): TrustDecision {
    // If no write lock, don't allow any actions
    if (!hasWriteLock) {
      return {
        allowed: false,
        requiresConfirmation: false,
        requiresDangerConfirm: false,
        reason: "Write lock not held. Another instance may be editing.",
      };
    }

    const risk = action.risk;

    switch (risk) {
      case "low":
        return this.evaluateLowRisk(action);
      case "medium":
        return this.evaluateMediumRisk(action);
      case "high":
        return this.evaluateHighRisk(action);
      default:
        return {
          allowed: false,
          requiresConfirmation: false,
          requiresDangerConfirm: false,
          reason: `Unknown risk level: ${risk}`,
        };
    }
  }

  /**
   * Evaluate a low-risk action
   */
  private evaluateLowRisk(action: ProposedAction): TrustDecision {
    if (this.policy.autoApplyLowRisk) {
      // Auto-apply allowed, no confirmation needed
      return {
        allowed: true,
        requiresConfirmation: false,
        requiresDangerConfirm: false,
      };
    }

    // User must click apply, but it's a simple one-click approval
    return {
      allowed: true,
      requiresConfirmation: true,
      requiresDangerConfirm: false,
      reason: "Low-risk actions require manual approval (auto-apply disabled)",
    };
  }

  /**
   * Evaluate a medium-risk action
   */
  private evaluateMediumRisk(_action: ProposedAction): TrustDecision {
    // Medium-risk always requires confirmation in Phase 2
    return {
      allowed: true,
      requiresConfirmation: true,
      requiresDangerConfirm: false,
      reason: "Medium-risk actions require confirmation",
    };
  }

  /**
   * Evaluate a high-risk action
   * NOTE: High-risk actions are disabled until Phase 3
   */
  private evaluateHighRisk(_action: ProposedAction): TrustDecision {
    // High-risk actions are proposal-only until Phase 3
    return {
      allowed: false,
      requiresConfirmation: true,
      requiresDangerConfirm: true,
      reason: "High-risk actions coming in Phase 3",
    };
  }

  /**
   * Check if an action can be auto-applied without any user interaction
   */
  canAutoApply(action: ProposedAction, hasWriteLock = true): boolean {
    const decision = this.evaluate(action, hasWriteLock);
    return decision.allowed && !decision.requiresConfirmation;
  }

  /**
   * Check if an action requires danger confirmation (extra friction)
   */
  requiresDangerConfirm(action: ProposedAction): boolean {
    return action.risk === "high";
  }

  /**
   * Get the appropriate confirmation message for an action
   */
  getConfirmationMessage(action: ProposedAction): string {
    switch (action.risk) {
      case "low":
        return `Apply "${action.title}"?`;
      case "medium":
        return `This will ${this.getActionVerb(action.type)} ${this.getTargetName(action.target)}. Continue?`;
      case "high":
        return `⚠️ Warning: This is a high-risk action that will ${this.getActionVerb(action.type)} ${this.getTargetName(action.target)}. This change may be difficult to undo. Are you sure?`;
      default:
        return `Apply "${action.title}"?`;
    }
  }

  /**
   * Get action verb for confirmation messages
   */
  private getActionVerb(type: string): string {
    switch (type) {
      case "frontmatter_set":
        return "modify the frontmatter of";
      case "frontmatter_add_tags":
        return "add tags to";
      case "append_section":
        return "append a section to";
      case "append_related_links":
        return "add related links to";
      case "move_note":
        return "move";
      case "merge_notes":
        return "merge notes into";
      case "trash_note":
        return "trash";
      default:
        return "modify";
    }
  }

  /**
   * Get target name from path for confirmation messages
   */
  private getTargetName(target: string): string {
    const parts = target.split("/");
    return parts[parts.length - 1]?.replace(".md", "") || target;
  }

  /**
   * Update the trust policy
   */
  updatePolicy(policy: Partial<TrustPolicy>): void {
    if (policy.autoApplyLowRisk !== undefined) {
      this.policy.autoApplyLowRisk = policy.autoApplyLowRisk;
    }
    if (policy.requireConfirmMediumRisk !== undefined) {
      this.policy.requireConfirmMediumRisk = policy.requireConfirmMediumRisk;
    }
    if (policy.requireConfirmHighRisk !== undefined) {
      this.policy.requireConfirmHighRisk = policy.requireConfirmHighRisk;
    }
  }

  /**
   * Get the current trust policy
   */
  getPolicy(): Readonly<TrustPolicy> {
    return { ...this.policy };
  }

  /**
   * Get risk level label for UI display
   */
  static getRiskLabel(risk: RiskLevel): string {
    switch (risk) {
      case "low":
        return "Low Risk";
      case "medium":
        return "Medium Risk";
      case "high":
        return "High Risk";
      default:
        return "Unknown Risk";
    }
  }

  /**
   * Get risk level description for UI tooltips
   */
  static getRiskDescription(risk: RiskLevel): string {
    switch (risk) {
      case "low":
        return "Safe to apply, easily reversible (e.g., add tags, modify frontmatter)";
      case "medium":
        return "Requires confirmation, reversible with some effort (e.g., move notes, add links)";
      case "high":
        return "Requires explicit confirmation, may be difficult to undo (e.g., merge, trash)";
      default:
        return "Unknown risk level";
    }
  }

  /**
   * Get risk level color for UI styling
   */
  static getRiskColor(risk: RiskLevel): string {
    switch (risk) {
      case "low":
        return "var(--nv2-accent)";
      case "medium":
        return "var(--nv2-status-warning)";
      case "high":
        return "var(--nv2-status-error)";
      default:
        return "var(--nv2-text-secondary)";
    }
  }
}
