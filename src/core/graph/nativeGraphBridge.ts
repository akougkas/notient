import { mergeFrontmatter } from "../chat/tools/notes";
import type { RecordHistoryInput } from "../history/types";
import { addRelatedLink } from "./relatedSection";

export type RelationKind = "contradicts" | "supports" | "extends" | "synthesizes_from";

export interface NativeGraphBridgeFacade {
  readNote(path: string): Promise<string>;
  writeNote(path: string, content: string): Promise<void>;
  updateFrontmatter(path: string, patch: Record<string, unknown>): Promise<void>;
}

export interface NativeGraphBridgeEchoGuard {
  mark(path: string, sha: string): void;
}

export interface NativeGraphBridgeSettings {
  writeRelatedSection: boolean;
  writeFrontmatterRelations: boolean;
  relatedSectionHeading: string;
}

export interface NativeGraphBridgeOptions {
  facade: NativeGraphBridgeFacade;
  echoGuard: NativeGraphBridgeEchoGuard;
  hash: (content: string) => Promise<string>;
  settings: () => NativeGraphBridgeSettings;
  recordHistory?: (input: RecordHistoryInput) => Promise<number>;
}

export interface ApprovedLink {
  sourcePath: string;
  targetPath: string;
  agent: string;
}

export interface RelatedRelation {
  sourcePath: string;
  targetPath: string;
  relation: RelationKind;
  agent: string;
}

export class NativeGraphBridge {
  constructor(private readonly options: NativeGraphBridgeOptions) {}

  async applyApprovedLink(link: ApprovedLink): Promise<void> {
    const settings = this.options.settings();
    if (!settings.writeRelatedSection) return;
    const content = await this.options.facade.readNote(link.sourcePath);
    const wikilink = `[[${basenameWithoutExtension(link.targetPath)}]]`;
    const next = addRelatedLink(content, settings.relatedSectionHeading, wikilink);
    if (next === content) return;
    const sha = await this.options.hash(next);
    this.options.echoGuard.mark(link.sourcePath, sha);
    await this.options.facade.writeNote(link.sourcePath, next);
    await this.options.recordHistory?.({
      kind: "note.append_section",
      target: link.sourcePath,
      before: content,
      after: next,
    });
  }

  async applyApprovedRelation(relation: RelatedRelation): Promise<void> {
    const settings = this.options.settings();
    if (!settings.writeFrontmatterRelations) return;
    const content = await this.options.facade.readNote(relation.sourcePath);
    const wikilink = `[[${basenameWithoutExtension(relation.targetPath)}]]`;
    const next = mergeFrontmatter(content, {
      notient: { [relation.relation]: [wikilink] },
    });
    if (next === content) return;
    const sha = await this.options.hash(next);
    this.options.echoGuard.mark(relation.sourcePath, sha);
    await this.options.facade.writeNote(relation.sourcePath, next);
    await this.options.recordHistory?.({
      kind: "note.frontmatter",
      target: relation.sourcePath,
      before: content,
      after: next,
    });
  }
}

function basenameWithoutExtension(path: string): string {
  const last = path.split("/").pop() ?? path;
  return last.replace(/\.md$/i, "");
}
