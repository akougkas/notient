import type { Skill } from "./types";
import { jsonCanvasSkill } from "./definitions/jsonCanvas";
import { obsidianMarkdownSkill } from "./definitions/obsidianMarkdown";
import { obsidianBasesSkill } from "./definitions/obsidianBases";

export class SkillRegistry {
  private skills: Map<string, Skill> = new Map();

  constructor() {
    this.register(jsonCanvasSkill);
    this.register(obsidianMarkdownSkill);
    this.register(obsidianBasesSkill);
  }

  register(skill: Skill) {
    this.skills.set(skill.id, skill);
  }

  get(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  getAll(): Skill[] {
    return Array.from(this.skills.values());
  }

  /**
   * Determine which skills are relevant based on a user query.
   * (Simple keyword matching for now, can be LLM-driven later)
   */
  identifyRelevantSkills(query: string): Skill[] {
    const relevant: Skill[] = [];
    const lowerQuery = query.toLowerCase();

    // Basic heuristic matching
    if (lowerQuery.includes("canvas") || lowerQuery.includes("diagram") || lowerQuery.includes("mind map")) {
      const skill = this.get("json-canvas");
      if (skill) relevant.push(skill);
    }
    
    if (lowerQuery.includes("base") || lowerQuery.includes("view") || lowerQuery.includes("database") || lowerQuery.includes("table")) {
      const skill = this.get("obsidian-bases");
      if (skill) relevant.push(skill);
    }

    // Markdown skill is almost always useful for editing
    if (lowerQuery.includes("edit") || lowerQuery.includes("write") || lowerQuery.includes("create") || lowerQuery.includes("note")) {
       const skill = this.get("obsidian-markdown");
       if (skill) relevant.push(skill);
    }

    return relevant;
  }
}
