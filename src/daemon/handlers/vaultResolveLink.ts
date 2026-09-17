/**
 * `vault.resolve_link` — turn an Ask citation into one indexed note path.
 *
 * Citations arrive either as Obsidian wikilinks (`[[Note]]`, including the
 * usual alias/heading suffixes) or as bare vault-relative Markdown paths.
 * Resolution deliberately delegates to the same resolver and SurrealDB path
 * universe Tier 1 uses, so the TUI never guesses a filesystem path locally.
 */

import type { Surreal } from "surrealdb";
import type { NoteSelector } from "../../api/schema";
import { listNotePaths } from "../../core/db/surreal";
import { parseWikilinkInner } from "../../core/markdown/plugins/remarkWikilink";
import { resolveTargets } from "../../core/markdown/resolver";
import { isCanonicalOrdinaryNotePath } from "../../core/vault/publicPath";
import { RpcError, type RpcRequestContext } from "../rpc";
import type { VaultResolveLinkResult } from "../wire";

export interface VaultResolveLinkDeps {
  db: Surreal;
}

const RESOLVER_ORIGIN = "__notient_rpc__.md";
const WIKILINK = /^\[\[([^\]\n]+)\]\]$/;

/** Extract only the note target; aliases, headings, and block ids do not affect its path. */
function citationTarget(link: string): { target: string; selector: NoteSelector | null } {
  const match = WIKILINK.exec(link);
  const parsed = parseWikilinkInner(match?.[1] ?? link);
  return {
    target: parsed.target,
    selector: parsed.block
      ? { kind: "block", id: parsed.block }
      : parsed.heading
        ? { kind: "heading", text: parsed.heading }
        : null,
  };
}

export function makeVaultResolveLinkHandler(deps: VaultResolveLinkDeps) {
  return async ({ params }: RpcRequestContext): Promise<VaultResolveLinkResult> => {
    if (
      Object.keys(params).length !== 1 ||
      !Object.hasOwn(params, "target") ||
      typeof params.target !== "string"
    ) {
      throw new RpcError("INVALID_PARAMS", "vault.resolve_link requires exactly one string target");
    }
    const target = params.target.trim();
    if (target.length === 0 || target.length > 4_096 || containsControl(target)) {
      throw new RpcError(
        "INVALID_PARAMS",
        "target must be a non-empty citation of at most 4096 characters without controls",
      );
    }

    // Surreal does not promise row order. Sorting makes duplicate-basename
    // ties deterministic when an Ask citation has no originating note whose
    // folder could otherwise disambiguate the candidates.
    const vaultPaths = (await listNotePaths(deps.db)).filter(isCanonicalOrdinaryNotePath).sort();
    const citation = citationTarget(target);
    const exact =
      vaultPaths.includes(citation.target) || vaultPaths.includes(`${citation.target}.md`);
    if (!exact && !citation.target.includes("/")) {
      const candidates = vaultPaths.filter(
        (path) =>
          path.split("/").at(-1)?.replace(/\.md$/, "") === citation.target.replace(/\.md$/, ""),
      );
      if (candidates.length > 1)
        throw new RpcError(
          "CONFLICT",
          "Citation matches multiple notes. Use a vault-relative path to choose the intended source.",
        );
    }
    const resolution = resolveTargets(
      RESOLVER_ORIGIN,
      [{ rawTarget: citation.target, targetHeading: null, targetBlockId: null }],
      vaultPaths,
    )[0];
    const path = resolution?.targetPath ?? null;
    if (path !== null && !isCanonicalOrdinaryNotePath(path)) {
      throw new Error("vault.resolve_link storage integrity: resolved an internal or invalid path");
    }
    return path === null
      ? { ok: true, resolved: false, path: null }
      : { ok: true, resolved: true, path, selector: citation.selector };
  };
}

function containsControl(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point !== undefined && (point < 32 || point === 127)) return true;
  }
  return false;
}
