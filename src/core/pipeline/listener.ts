/**
 * Pipeline Event Listener
 * Connects enhance:start events to the enhancement pipeline execution
 */

import type { AgentContext, EnhanceStartPayload, NoteMetadata } from "../../types";
import type { EventBus } from "../events";
import { kernel } from "../kernel";
import { runEnhancePipeline } from "./enhancePipeline";

/**
 * Build AgentContext from note path
 * Reads note content and metadata from vault
 */
async function buildAgentContext(noteId: string): Promise<AgentContext | null> {
  const facade = kernel.get("obsidianFacade");

  let content: string;
  try {
    content = await facade.readNote(noteId);
  } catch {
    return null;
  }

  // Extract frontmatter if present
  const frontmatter: Record<string, unknown> = {};
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (frontmatterMatch) {
    try {
      const yaml = frontmatterMatch[1];
      // Simple YAML parsing for key: value pairs
      for (const line of yaml.split("\n")) {
        const colonIndex = line.indexOf(":");
        if (colonIndex > 0) {
          const key = line.slice(0, colonIndex).trim();
          const value = line.slice(colonIndex + 1).trim();
          frontmatter[key] = value;
        }
      }
    } catch {
      // Ignore frontmatter parsing errors
    }
  }

  // Extract tags from frontmatter
  const rawTags = frontmatter.tags;
  let tags: string[] = [];
  if (typeof rawTags === "string") {
    tags = rawTags.split(",").map((t) => t.trim());
  } else if (Array.isArray(rawTags)) {
    tags = rawTags.map(String);
  }

  // Build minimal metadata
  const metadata: NoteMetadata = {
    hash: hashContent(content),
    title: noteId.split("/").pop()?.replace(".md", "") ?? noteId,
    maturity: "raw",
    origin: "unknown",
    vitals: {
      healthScore: 0,
      connectivity: 0,
      structure: 0,
      freshness: 0,
    },
    links: { inbound: [], outbound: [] },
    tags,
  };

  return {
    noteContent: content,
    notePath: noteId,
    frontmatter,
    metadata,
  };
}

/**
 * Simple hash function for content
 */
function hashContent(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

/**
 * Start listening for enhance:start events and trigger pipeline execution
 * @returns Cleanup function to call on unload
 */
export function startPipelineListener(eventBus: EventBus): () => void {
  const handler = async (payload: EnhanceStartPayload) => {
    const context = await buildAgentContext(payload.noteId);
    if (!context) {
      eventBus.emit("enhance:error", {
        noteId: payload.noteId,
        error: "Failed to read note",
      });
      return;
    }

    // Run pipeline - it emits its own progress and complete events
    await runEnhancePipeline(context);
  };

  eventBus.on("enhance:start", handler);

  return () => {
    eventBus.off("enhance:start", handler);
  };
}
