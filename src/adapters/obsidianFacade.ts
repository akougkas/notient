import type { App, TFile, Vault } from "obsidian";
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

  async write(path: string, contents: string): Promise<void> {
    const fs = this.adapterFs();
    await atomicWrite(fs, path, contents);
  }

  async remove(path: string): Promise<void> {
    const file = this.requireFile(path);
    await this.app.vault.delete(file);
  }

  async exists(path: string): Promise<boolean> {
    return await this.app.vault.adapter.exists(path);
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
