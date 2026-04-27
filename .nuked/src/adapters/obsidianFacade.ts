import type { App, TFile, Vault } from "obsidian";
import { mergeFrontmatter } from "../core/chat/tools/notes";
import { type AtomicFs, atomicWrite } from "../core/utils/atomicWrite";

export interface VaultIO {
  listMarkdown(): { path: string; mtime: number }[];
  read(path: string): Promise<string>;
  write(path: string, contents: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export class ObsidianFacade implements VaultIO {
  constructor(private readonly app: App) {}

  listMarkdown(): { path: string; mtime: number }[] {
    return this.app.vault
      .getMarkdownFiles()
      .map((file: TFile) => ({ path: file.path, mtime: file.stat.mtime }));
  }

  async read(path: string): Promise<string> {
    const file = this.requireFile(path);
    return await this.app.vault.read(file);
  }

  /**
   * Phase 4 alias for {@link read}. Phase 4 services declare a `readNote`
   * contract; the alias avoids touching every callsite while keeping the
   * canonical method available for Phase 1-3 code.
   */
  async readNote(path: string): Promise<string> {
    return this.read(path);
  }

  async write(path: string, contents: string): Promise<void> {
    const fs = this.adapterFs();
    await atomicWrite(fs, path, contents);
  }

  /**
   * Phase 4 alias for {@link write}. Mirrors `readNote` so Phase 4 modules
   * (history inverters, native graph bridge, chat note tools) can speak a
   * uniform `readNote`/`writeNote` vocabulary.
   */
  async writeNote(path: string, contents: string): Promise<void> {
    return this.write(path, contents);
  }

  /**
   * Read-modify-atomic-write of the YAML frontmatter for `path`. Reuses
   * {@link mergeFrontmatter} from the chat write-tools module so the merge
   * rules (shallow patch, deep merge for the `notient` block) stay in lockstep
   * with the chat tool semantics. Used by VitalsService and NativeGraphBridge.
   */
  async updateFrontmatter(path: string, patch: Record<string, unknown>): Promise<void> {
    const before = (await this.exists(path)) ? await this.read(path) : "";
    const next = mergeFrontmatter(before, patch);
    if (next === before) return;
    await this.write(path, next);
  }

  async remove(path: string): Promise<void> {
    const file = this.requireFile(path);
    await this.app.vault.delete(file);
  }

  async exists(path: string): Promise<boolean> {
    return await this.app.vault.adapter.exists(path);
  }

  /**
   * Bootstrap helper used by VaultBootstrap (Phase 4 Task 0). Creates the
   * folder when it does not already exist; otherwise no-op.
   */
  async createFolder(path: string): Promise<void> {
    if (await this.exists(path)) return;
    await this.app.vault.createFolder(path);
  }

  private requireFile(path: string): TFile {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!f || !(f as TFile).stat) throw new Error(`Not a file: ${path}`);
    return f as TFile;
  }

  private adapterFs(): AtomicFs {
    const adapter = this.app.vault.adapter;
    return {
      writeBinary: (p, d) => adapter.writeBinary(p, d),
      rename: (from, to) => adapter.rename(from, to),
      remove: (p) => adapter.remove(p),
    };
  }

  vault(): Vault {
    return this.app.vault;
  }
}
