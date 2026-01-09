/**
 * User Profile Types
 *
 * Defines the user profile schema for the Notient identity system.
 * Profile allows Notient to adapt its expertise to match user's domain
 * and vault organization.
 */

/**
 * User profile for domain-specific prompt adaptation
 */
export interface UserProfile {
  /** Schema version for migrations */
  version: "1.0";

  /** User's domain expertise */
  domain: {
    /** Primary field of expertise (e.g., "High-Performance Computing", "Law", "Biology") */
    primary: string;
    /** Related fields (e.g., ["AI/ML", "Distributed Systems"]) */
    secondary?: string[];
    /** Domain-specific keywords (e.g., ["NSF grants", "supercomputing", "MPI"]) */
    keywords?: string[];
  };

  /** PARA folder mappings */
  para: {
    /** Project folders (active work with deadlines) */
    projects: string[];
    /** Area folders (ongoing responsibilities) */
    areas: string[];
    /** Resource folders (reference material) */
    resources: string[];
    /** Archive folders (completed/inactive items) */
    archives: string[];
  };

  /** Optional user preferences */
  preferences?: {
    /** How to format citations */
    citationStyle?: "wikilink" | "markdown";
    /** Tone of responses */
    formality?: "formal" | "balanced" | "casual";
  };
}

/**
 * Result of profile validation
 */
export interface ProfileValidationResult {
  /** Whether the profile is valid */
  valid: boolean;
  /** List of validation errors */
  errors: string[];
  /** List of validation warnings */
  warnings: string[];
}

/**
 * Status of profile inference process
 */
export type ProfileInferenceStatus =
  | "idle"
  | "checking_index"
  | "clustering"
  | "analyzing"
  | "detecting_para"
  | "complete"
  | "error";

/**
 * Progress callback for inference process
 */
export type ProfileInferenceCallback = (status: ProfileInferenceStatus, message: string) => void;

/**
 * Result of LLM domain inference
 */
export interface DomainInferenceResult {
  primary: string;
  secondary: string[];
  keywords: string[];
}

/**
 * Create an empty profile with default values
 */
export function createEmptyProfile(): UserProfile {
  return {
    version: "1.0",
    domain: {
      primary: "",
      secondary: [],
      keywords: [],
    },
    para: {
      projects: [],
      areas: [],
      resources: [],
      archives: [],
    },
    preferences: {
      citationStyle: "wikilink",
      formality: "formal",
    },
  };
}

/**
 * Check if a profile has meaningful domain data
 */
export function hasProfileDomain(profile: UserProfile | undefined): boolean {
  return Boolean(profile?.domain?.primary?.trim());
}
