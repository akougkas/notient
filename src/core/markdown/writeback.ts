import type { Heading, List, ListItem, Root, Yaml } from "mdast";
import YAML from "yaml";
import { processAst, stringify } from "./pipeline";
import type { WikiLinkNode } from "./plugins/remarkWikilink";

/**
 * AST-aware writeback for approved cross-document edges.
 *
 * Two pure entry points:
 *   applyApprovedLink     appends a `[[target]]` (or qualified variant) under
 *                         a `## Related` H2, creating the section if absent.
 *   applyApprovedRelation appends `[[target]]` under
 *                         `frontmatter.notient.<key>` array, creating the
 *                         frontmatter and `notient` mapping if absent.
 *
 * Both functions are pure: input markdown string in, output markdown string
 * out. They never touch the filesystem, never record provenance, and never
 * coordinate with approval/history stores. The caller (Task 3 approval-and-
 * write flow) wires these into the agreed failure-semantics contract and
 * provenance recording.
 *
 * Both functions are idempotent: when the approved edge is already present
 * the original `source` is returned unchanged (byte-for-byte). Only when a
 * mutation is required do we re-stringify the AST.
 *
 * Implementation strategy (Locked Decision 2, spec §8.4):
 *   1. `processAst(source)` to obtain a fully-typed mdast tree containing
 *      `wikiLink` / `wikiEmbed` / `yaml` nodes.
 *   2. Mutate the AST in place (heading + list for `## Related`; raw YAML
 *      string for the frontmatter `yaml` node).
 *   3. `stringify(ast)` via the same pipeline. The pipeline now registers
 *      stringify handlers for `wikiLink` / `wikiEmbed`, so the round-trip is
 *      closed and Obsidian wikilink syntax is preserved.
 *
 * Frontmatter is treated as YAML rather than as mdast: the `yaml` node's
 * `value` is an opaque raw YAML body. We parse it into a JS object via the
 * `yaml` package, mutate, and re-serialise back into `value`. The mdast
 * stringifier then emits the surrounding `---` fences.
 *
 * This module supersedes the legacy `nativeGraphBridge` / `relatedSection` /
 * `frontmatterWriter` helpers; Task 5 deletes those.
 *
 * TODO(Task 3): name the chosen failure-semantics contract (pending-state
 * OR inverted-order) here.
 */

export interface ApplyApprovedLinkInput {
  target: string;
  heading?: string;
  block?: string;
}

export interface ApplyApprovedRelationInput {
  key: string;
  target: string;
}

export function applyApprovedLink(source: string, input: ApplyApprovedLinkInput): string {
  if (input.heading !== undefined && input.block !== undefined) {
    throw new Error("applyApprovedLink: heading and block qualifiers are mutually exclusive");
  }
  const heading = input.heading ?? null;
  const block = input.block ?? null;

  const tree = processAst(source);
  const relatedHeadingIndex = findRelatedHeadingIndex(tree);

  if (relatedHeadingIndex === -1) {
    appendNewRelatedSection(tree, input.target, heading, block);
    return stringify(tree);
  }

  const list = findListAfterHeading(tree, relatedHeadingIndex);
  if (list === null) {
    insertListAfterHeading(tree, relatedHeadingIndex, input.target, heading, block);
    return stringify(tree);
  }

  if (listContainsLink(list, input.target, heading, block)) {
    return source;
  }

  list.children.push(buildWikilinkListItem(input.target, heading, block));
  return stringify(tree);
}

export function applyApprovedRelation(source: string, input: ApplyApprovedRelationInput): string {
  const tree = processAst(source);
  const yamlNode = findYamlNode(tree);
  const wikilink = `[[${input.target}]]`;

  if (yamlNode === null) {
    const newYaml = YAML.stringify({ notient: { [input.key]: [wikilink] } }).replace(/\n$/, "");
    const created: Yaml = { type: "yaml", value: newYaml };
    tree.children.unshift(created);
    return stringify(tree);
  }

  const parsed = parseYamlAsObject(yamlNode.value);
  const notient = ensureMapping(parsed, "notient");
  const list = ensureStringArray(notient, input.key);
  if (list.includes(wikilink)) {
    return source;
  }
  list.push(wikilink);
  notient[input.key] = list;
  parsed.notient = notient;

  yamlNode.value = YAML.stringify(parsed).replace(/\n$/, "");
  return stringify(tree);
}

function findRelatedHeadingIndex(tree: Root): number {
  for (let index = 0; index < tree.children.length; index += 1) {
    const child = tree.children[index];
    if (child !== undefined && child.type === "heading" && child.depth === 2) {
      if (headingPlainText(child) === "Related") {
        return index;
      }
    }
  }
  return -1;
}

function headingPlainText(heading: Heading): string {
  let out = "";
  for (const child of heading.children) {
    if (child.type === "text") {
      out += child.value;
    }
  }
  return out.trim();
}

function findListAfterHeading(tree: Root, headingIndex: number): List | null {
  const next = tree.children[headingIndex + 1];
  if (next === undefined) {
    return null;
  }
  if (next.type === "list") {
    return next;
  }
  return null;
}

function listContainsLink(
  list: List,
  target: string,
  heading: string | null,
  block: string | null,
): boolean {
  for (const item of list.children) {
    const link = firstWikilinkInListItem(item);
    if (link === null) {
      continue;
    }
    if (link.target === target && link.heading === heading && link.block === block) {
      return true;
    }
  }
  return false;
}

function firstWikilinkInListItem(item: ListItem): WikiLinkNode | null {
  for (const child of item.children) {
    if (child.type !== "paragraph") {
      continue;
    }
    for (const grand of child.children) {
      if (grand.type === "wikiLink") {
        return grand;
      }
    }
  }
  return null;
}

function buildWikilinkNode(
  target: string,
  heading: string | null,
  block: string | null,
): WikiLinkNode {
  return {
    type: "wikiLink",
    target,
    alias: null,
    heading,
    block,
  };
}

function buildWikilinkListItem(
  target: string,
  heading: string | null,
  block: string | null,
): ListItem {
  return {
    type: "listItem",
    spread: false,
    children: [
      {
        type: "paragraph",
        children: [buildWikilinkNode(target, heading, block)],
      },
    ],
  };
}

function appendNewRelatedSection(
  tree: Root,
  target: string,
  heading: string | null,
  block: string | null,
): void {
  const headingNode: Heading = {
    type: "heading",
    depth: 2,
    children: [{ type: "text", value: "Related" }],
  };
  const list: List = {
    type: "list",
    ordered: false,
    spread: false,
    children: [buildWikilinkListItem(target, heading, block)],
  };
  tree.children.push(headingNode, list);
}

function insertListAfterHeading(
  tree: Root,
  headingIndex: number,
  target: string,
  heading: string | null,
  block: string | null,
): void {
  const list: List = {
    type: "list",
    ordered: false,
    spread: false,
    children: [buildWikilinkListItem(target, heading, block)],
  };
  tree.children.splice(headingIndex + 1, 0, list);
}

function findYamlNode(tree: Root): Yaml | null {
  const first = tree.children[0];
  if (first !== undefined && first.type === "yaml") {
    return first;
  }
  return null;
}

function parseYamlAsObject(value: string): Record<string, unknown> {
  if (value.trim().length === 0) {
    return {};
  }
  const parsed = YAML.parse(value) as unknown;
  if (parsed === null || parsed === undefined) {
    return {};
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("frontmatter root must be a mapping");
  }
  return { ...(parsed as Record<string, unknown>) };
}

function ensureMapping(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (existing === undefined || existing === null) {
    return {};
  }
  if (typeof existing !== "object" || Array.isArray(existing)) {
    throw new Error(`frontmatter.${key} must be a mapping`);
  }
  return { ...(existing as Record<string, unknown>) };
}

function ensureStringArray(parent: Record<string, unknown>, key: string): string[] {
  const existing = parent[key];
  if (existing === undefined || existing === null) {
    return [];
  }
  if (!Array.isArray(existing)) {
    throw new Error(`frontmatter.notient.${key} must be an array`);
  }
  const out: string[] = [];
  for (const entry of existing) {
    if (typeof entry !== "string") {
      throw new Error(`frontmatter.notient.${key} entries must be strings`);
    }
    out.push(entry);
  }
  return out;
}
