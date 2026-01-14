import type { JsonSchemaFormat } from "../llm/types";

export interface Skill {
  /** Unique identifier (e.g., 'json-canvas', 'obsidian-markdown') */
  id: string;
  
  /** Human-readable name */
  name: string;
  
  /** 
   * Description for the Orchestrator/Router.
   * Used to decide IF this skill should be injected into the context.
   */
  description: string;
  
  /** 
   * The actual instructions to be added to the System Prompt.
   * Derived from the spec files (e.g. "JSON Canvas Spec 1.0...").
   */
  systemPrompt: string;
  
  /**
   * Optional: Few-shot examples to help local LLMs understand the pattern.
   * Critical for smaller models (8B param class).
   */
  examples?: Array<{ user: string; assistant: string }>;

  /** 
   * Optional: Strict output schema.
   * If present, the Agent can enforce this via 'responseFormat'.
   */
  schema?: JsonSchemaFormat;
}
