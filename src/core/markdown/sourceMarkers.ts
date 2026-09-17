import { visit } from "unist-util-visit";
import { parse } from "./pipeline";

/** Internal document indices are not usable citations in a saved Markdown note.
 * Literal code (including array indexing) remains untouched. A rejected final
 * response uses the context's existing bounded, accounted schema correction. */
export function hasInternalSourceMarkers(text: string): boolean {
  let found = false;
  visit(parse(text), "text", (node) => {
    if (/(?:^|\s)\[\d+\](?=$|\s|[.,;:!?])/u.test(node.value)) found = true;
  });
  return found;
}
