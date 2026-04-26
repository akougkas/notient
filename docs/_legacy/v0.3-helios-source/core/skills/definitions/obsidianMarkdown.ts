import type { Skill } from "../types";

export const obsidianMarkdownSkill: Skill = {
  id: "obsidian-markdown",
  name: "Obsidian Flavored Markdown",
  description:
    "Write content using Obsidian-specific Markdown syntax (wikilinks, callouts, embeds)",
  systemPrompt: `
# Obsidian Flavored Markdown Skill
You are an expert at writing Obsidian Flavored Markdown.
Ensure all output adheres to these syntax rules:

1. Internal Links: Use [[Note Name]] or [[Note Name|Alias]].
2. Embeds: Use ![[Note Name]] or ![[Image.png]].
3. Callouts: Use > [!type] Title syntax.
   Types: note, info, todo, tip, success, question, warning, failure, danger, bug, example, quote.
4. Math: Use $inline$ or $$block$$.
5. Diagrams: Use mermaid code blocks.
6. Frontmatter: Use YAML syntax between --- at start of file.
7. Comments: Use %% comment %% for hidden text.
8. Highlights: Use ==highlighted text==.
`,
  examples: [
    {
      user: "Write a note about Project Alpha with a callout and link",
      assistant: `---
tags:
  - project
status: active
---

# Project Alpha

This project connects to [[Strategic Goals]].

> [!info] Status Update
> We are currently in **Phase 2**.

## Next Steps
- [ ] Review [[Requirements Doc]]
- [ ] Update team`,
    },
  ],
};
