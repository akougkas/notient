import { dirname, normalize, relative } from "node:path/posix";
import type { Definition, Image, ImageReference, Link, LinkReference } from "mdast";
import { visit } from "unist-util-visit";
import { isScalar, parseDocument, visit as visitYaml } from "yaml";
import { inspectMarkdown } from "../../api/notes";
import { locateFrontmatter } from "./frontmatter";
import { parse } from "./pipeline";

export interface ReferenceMoveResult {
  body: string;
  count: number;
  ambiguous: string[];
}

/** Byte splices over parsed links; unrelated Markdown, aliases and fragments survive. */
export function rewriteMovedReferences(
  body: string,
  referringPath: string,
  from: string,
  to: string,
  universe: string[],
  movedReferringPath = referringPath,
): ReferenceMoveResult {
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const ambiguous: string[] = [];
  const structure = inspectMarkdown(body);
  const ast = parse(body.replace(/^\ufeff/, ""));
  const definitions = new Map<string, Definition>();
  const destinations = new Map<number, Link | Image | LinkReference | ImageReference>();
  const bom = body.startsWith("\ufeff") ? 1 : 0;
  visit(ast, (node) => {
    if (node.type === "definition" && !definitions.has(node.identifier))
      definitions.set(node.identifier, node);
    if (["link", "image", "linkReference", "imageReference"].includes(node.type) && node.position)
      destinations.set(
        (node.position.start.offset ?? 0) + bom,
        node as Link | Image | LinkReference | ImageReference,
      );
  });
  for (const link of structure.links) {
    const raw = body.slice(link.range.start, link.range.end);
    const fragmentAt = link.target.indexOf("#");
    const targetPart = fragmentAt < 0 ? link.target : link.target.slice(0, fragmentAt);
    const fragment = fragmentAt < 0 ? "" : link.target.slice(fragmentAt);
    const candidates = referenceCandidates(referringPath, targetPart, link.kind, universe);
    if (
      candidates.length > 1 &&
      (candidates.includes(from) || referringPath !== movedReferringPath)
    ) {
      ambiguous.push(raw);
      continue;
    }
    let resolved = candidates.length === 1 ? candidates[0] : null;
    if (
      !resolved &&
      referringPath !== movedReferringPath &&
      link.kind === "markdown" &&
      targetPart &&
      !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(targetPart)
    ) {
      // Attachments need not be Markdown-indexed. Preserve a relative outgoing
      // destination's identity even when it is an image/PDF or currently missing.
      try {
        const decoded = decodeURIComponent(targetPart);
        const path = normalize(
          decoded.startsWith("/") ? decoded.slice(1) : `${dirname(referringPath)}/${decoded}`,
        );
        if (!path.startsWith("../") && path !== ".." && !path.startsWith("/")) resolved = path;
      } catch {
        ambiguous.push(`Invalid destination encoding: ${raw}`);
      }
    }
    // Relative outgoing links inside the moved note also need rebasing.
    if (resolved !== from && !(referringPath !== movedReferringPath && resolved)) continue;
    const target = resolved === from ? to : resolved;
    if (!target) continue;
    if (link.kind === "wiki") {
      const offset = raw.startsWith("!") ? 3 : 2;
      const spelling = raw.slice(offset, -2).split(/[|#]/, 1)[0];
      const leading = spelling.length - spelling.trimStart().length;
      edits.push({
        start: link.range.start + offset + leading,
        end: link.range.start + offset + leading + spelling.trim().length,
        text: target.endsWith(".md") && !link.target.endsWith(".md") ? target.slice(0, -3) : target,
      });
    } else {
      let start = link.range.start;
      let position = -1;
      const node = destinations.get(link.range.start);
      if (node?.type === "link" || node?.type === "image") {
        const labelEnd =
          node.type === "link"
            ? (node.children.at(-1)?.position?.end.offset ?? start - bom) + bom - start
            : 0;
        const resource = raw.indexOf("](", labelEnd);
        if (resource >= 0) position = raw.indexOf(link.target, resource + 2);
      } else if (node?.type === "linkReference" || node?.type === "imageReference") {
        // A reference-style use points at the definition's destination. Edit
        // that destination once, leaving every label/use and its title intact.
        const definition = definitions.get(node.identifier);
        if (definition?.position) {
          start = definition.position.start.offset! + bom;
          const value = body.slice(start, definition.position.end.offset! + bom);
          position = value.indexOf(link.target, value.indexOf("]:") + 2);
        }
      }
      if (position < 0) {
        ambiguous.push(`Reference definition requires review: ${raw}`);
        continue;
      }
      let rebased = targetPart.startsWith("/")
        ? `/${target}`
        : relative(dirname(movedReferringPath), target);
      if (!targetPart.endsWith(".md") && target.endsWith(".md")) rebased = rebased.slice(0, -3);
      const encoded = rebased
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
      edits.push({
        start: start + position,
        end: start + position + link.target.length,
        text: encoded + fragment,
      });
    }
  }
  const properties = propertyReferenceEdits(
    body,
    referringPath,
    from,
    to,
    universe,
    movedReferringPath,
  );
  edits.push(...properties.edits);
  ambiguous.push(...properties.ambiguous);
  let output = body;
  const unique = [
    ...new Map(edits.map((edit) => [`${edit.start}:${edit.end}`, edit])).values(),
  ].filter((edit) => body.slice(edit.start, edit.end) !== edit.text);
  for (const edit of unique.sort((a, b) => b.start - a.start))
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  return { body: output, count: unique.length, ambiguous };
}

export function referenceCandidates(
  referringPath: string,
  target: string,
  kind: "wiki" | "markdown",
  universe: string[],
): string[] {
  if (!target || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) return [];
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return [];
  }
  if (kind === "markdown") {
    const path = decoded.startsWith("/")
      ? normalize(decoded.slice(1))
      : normalize(`${dirname(referringPath)}/${decoded}`);
    return universe.includes(path) ? [path] : universe.includes(`${path}.md`) ? [`${path}.md`] : [];
  }
  const exact = universe.filter((path) => path === decoded || path === `${decoded}.md`);
  if (exact.length) return exact;
  const local = normalize(`${dirname(referringPath)}/${decoded}`);
  const localMatch = universe.filter((path) => path === local || path === `${local}.md`);
  if (localMatch.length) return localMatch;
  if (decoded.includes("/")) return [];
  return universe.filter(
    (path) => path.split("/").at(-1)?.replace(/\.md$/i, "") === decoded.replace(/\.md$/i, ""),
  );
}

function propertyReferenceEdits(
  body: string,
  referringPath: string,
  from: string,
  to: string,
  universe: string[],
  movedReferringPath: string,
) {
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const ambiguous: string[] = [];
  const location = locateFrontmatter(body);
  if (!location) return { edits, ambiguous };
  const document = parseDocument(location.raw);
  if (document.errors.length) {
    const related = [...location.raw.matchAll(/\[\[([^\]\r\n]+)\]\]/g)].some(
      (match) =>
        referringPath !== movedReferringPath ||
        referenceCandidates(
          referringPath,
          match[1].split(/[|#]/, 1)[0].trim(),
          "wiki",
          universe,
        ).includes(from),
    );
    if (related)
      ambiguous.push(
        "Frontmatter contains affected links but its YAML is invalid; repair it before moving linked notes.",
      );
    return { edits, ambiguous };
  }
  const offset = body.indexOf("\n", location.start) + 1;
  visitYaml(document, (key, node) => {
    if (key === "key" || !isScalar(node) || typeof node.value !== "string" || !node.range) return;
    const raw = location.raw.slice(node.range[0], node.range[1]);
    if (!raw.includes("[[") && node.value.includes("[[")) {
      const related = [...node.value.matchAll(/\[\[([^\]\r\n]+)\]\]/g)].some(
        (match) =>
          referringPath !== movedReferringPath ||
          referenceCandidates(
            referringPath,
            match[1].split(/[|#]/, 1)[0].trim(),
            "wiki",
            universe,
          ).includes(from),
      );
      if (related)
        ambiguous.push("A Unicode-escaped YAML link requires review before moving its target.");
    }
    for (const match of raw.matchAll(/\[\[([^\]\r\n]+)\]\]/g)) {
      const rawTarget = match[1].split(/[|#]/, 1)[0];
      let target = rawTarget;
      if (node.type === "QUOTE_SINGLE") target = target.replaceAll("''", "'");
      if (node.type === "QUOTE_DOUBLE") {
        try {
          target = JSON.parse(`"${target}"`);
        } catch {
          ambiguous.push("Escaped YAML link requires review.");
          continue;
        }
      }
      const candidates = referenceCandidates(referringPath, target.trim(), "wiki", universe);
      if (
        candidates.length > 1 &&
        (candidates.includes(from) || referringPath !== movedReferringPath)
      ) {
        ambiguous.push(match[0]);
        continue;
      }
      const resolved = candidates.length === 1 ? candidates[0] : null;
      if (!resolved || (resolved !== from && referringPath === movedReferringPath)) continue;
      let replacement = resolved === from ? to : resolved;
      if (!target.endsWith(".md")) replacement = replacement.replace(/\.md$/, "");
      if (node.type === "QUOTE_SINGLE") replacement = replacement.replaceAll("'", "''");
      if (node.type === "QUOTE_DOUBLE") replacement = JSON.stringify(replacement).slice(1, -1);
      replacement =
        (rawTarget.match(/^\s*/)?.[0] ?? "") + replacement + (rawTarget.match(/\s*$/)?.[0] ?? "");
      const start = offset + node.range[0] + match.index + 2;
      edits.push({ start, end: start + rawTarget.length, text: replacement });
    }
  });
  return { edits, ambiguous };
}
