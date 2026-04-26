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
  }

  async applyApprovedRelation(relation: RelatedRelation): Promise<void> {
    const settings = this.options.settings();
    if (!settings.writeFrontmatterRelations) return;
    const wikilink = `[[${basenameWithoutExtension(relation.targetPath)}]]`;
    await this.options.facade.updateFrontmatter(relation.sourcePath, {
      notient: { [relation.relation]: [wikilink] },
    });
  }
}

function basenameWithoutExtension(path: string): string {
  const last = path.split("/").pop() ?? path;
  return last.replace(/\.md$/i, "");
}
