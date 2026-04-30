import type { ChatMessage } from "../../llm/provider";
import type { SearchHit } from "../types";

export interface DeepSynthesizePromptInput {
  query: string;
  hits: SearchHit[];
  /** Maximum characters of snippet to include per hit. Defaults to 400. */
  snippetMaxChars?: number;
}

/**
 * Builds the grounded-synthesis prompt for Deep search. The model must reply
 * as a markdown bullet list with at most three bullets, each ending with at
 * least one `[[note title]]` wikilink citation drawn from the supplied hits.
 * Bullets without citations are dropped by the parser, so the prompt
 * explicitly forbids un-cited claims.
 */
export function deepSynthesizePrompt(input: DeepSynthesizePromptInput): ChatMessage[] {
  const snippetCap = input.snippetMaxChars ?? 400;
  const hitsBlock = input.hits
    .map((hit, index) => {
      // Graph-expanded hits can arrive with `notePath` undefined at runtime
      // (they carry `viaPath` instead). Fall back so the prompt builder never
      // calls `.split` on undefined.
      const sourcePath = resolveSourcePath(hit);
      const title = wikiTitleFor(sourcePath);
      const snippet = hit.snippet.slice(0, snippetCap).replace(/\s+/g, " ").trim();
      return `${index + 1}. [[${title}]]\n${snippet}`;
    })
    .join("\n\n");
  return [
    {
      role: "system",
      content: [
        "You answer the user's query using ONLY the provided notes.",
        "Reply as a markdown bullet list with at most three bullets.",
        "Every bullet MUST end with at least one [[note title]] citation drawn from the provided notes.",
        "If a claim is not supported by the notes, omit it. Never invent citations or note titles.",
        "Output the bullet list only. No preamble, no closing prose.",
      ].join(" "),
    },
    {
      role: "user",
      content: `Query: ${input.query}\n\nNotes:\n${hitsBlock}\n\nReply with bullets only.`,
    },
  ];
}

function wikiTitleFor(notePath: string): string {
  if (notePath.length === 0) return "unknown";
  const fileName = notePath.split("/").pop() ?? notePath;
  return fileName.replace(/\.md$/i, "");
}

/**
 * Returns a usable path for a hit. Graph-expanded hits can violate the
 * `SearchHit.notePath: string` contract by setting `notePath` to undefined and
 * placing the originating note in `viaPath` instead. Fall back gracefully so
 * the prompt builder is tolerant of the actual runtime shape.
 */
function resolveSourcePath(hit: SearchHit): string {
  const candidate = (hit as { notePath?: string; viaPath?: string }).notePath;
  if (typeof candidate === "string" && candidate.length > 0) return candidate;
  const fallback = (hit as { viaPath?: string }).viaPath;
  if (typeof fallback === "string" && fallback.length > 0) return fallback;
  return "";
}
