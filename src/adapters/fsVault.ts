import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import { mergeFrontmatter } from "../core/chat/tools/notes";
import { type AtomicFs, atomicWrite } from "../core/utils/atomicWrite";
import type { VaultAdapter, VaultListing } from "./vaultAdapter";

const DOT_PREFIXES = new Set([".notient", ".obsidian", ".git"]);
const HARD_SKIP = new Set(["node_modules"]);

export class FsVault implements VaultAdapter {
  private readonly atomic: AtomicFs;

  constructor(private readonly root: string) {
    this.atomic = {
      writeBinary: (path, data) => this.writeBinary(path, data),
      rename: (from, to) => this.rename(from, to),
      remove: (path) => this.remove(path),
    };
  }

  async listMarkdown(): Promise<{ path: string; mtime: number }[]> {
    const results: { path: string; mtime: number }[] = [];
    await this.walk(this.root, async (absolute, isDirectory) => {
      if (isDirectory) return;
      if (!absolute.endsWith(".md")) return;
      const stats = await stat(absolute);
      results.push({ path: this.toVaultPath(absolute), mtime: stats.mtimeMs });
    });
    return results;
  }

  async read(path: string): Promise<string> {
    return await readFile(this.toAbsolute(path), "utf-8");
  }

  async readNote(path: string): Promise<string> {
    return this.read(path);
  }

  async write(path: string, content: string): Promise<void> {
    await this.ensureParent(path);
    await atomicWrite(this.atomic, path, content);
  }

  async writeNote(path: string, content: string): Promise<void> {
    return this.write(path, content);
  }

  async updateFrontmatter(path: string, patch: Record<string, unknown>): Promise<void> {
    const before = (await this.exists(path)) ? await this.read(path) : "";
    const next = mergeFrontmatter(before, patch);
    if (next === before) return;
    await this.write(path, next);
  }

  async remove(path: string): Promise<void> {
    await rm(this.toAbsolute(path), { force: true });
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(this.toAbsolute(path));
      return true;
    } catch {
      return false;
    }
  }

  async createFolder(path: string): Promise<void> {
    await mkdir(this.toAbsolute(path), { recursive: true });
  }

  async list(folder: string): Promise<VaultListing> {
    const absolute = this.toAbsolute(folder);
    let entries: { name: string; isDirectory: () => boolean }[];
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      return { files: [], folders: [] };
    }
    const files: string[] = [];
    const folders: string[] = [];
    for (const entry of entries) {
      const childPath = folder === "" ? entry.name : `${folder}/${entry.name}`;
      if (entry.isDirectory()) {
        folders.push(childPath);
      } else {
        files.push(childPath);
      }
    }
    return { files, folders };
  }

  async readBinary(path: string): Promise<ArrayBuffer | null> {
    try {
      const buffer = await readFile(this.toAbsolute(path));
      return buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ) as ArrayBuffer;
    } catch {
      return null;
    }
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    const absolute = this.toAbsolute(path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, new Uint8Array(data));
  }

  async rename(from: string, to: string): Promise<void> {
    const fromAbsolute = this.toAbsolute(from);
    const toAbsolute = this.toAbsolute(to);
    await mkdir(dirname(toAbsolute), { recursive: true });
    await rename(fromAbsolute, toAbsolute);
  }

  private toAbsolute(path: string): string {
    return join(this.root, ...path.split("/"));
  }

  private toVaultPath(absolute: string): string {
    const relativePath = relative(this.root, absolute);
    return relativePath.split(sep).join(posix.sep);
  }

  private async ensureParent(path: string): Promise<void> {
    const absolute = this.toAbsolute(path);
    await mkdir(dirname(absolute), { recursive: true });
  }

  private async walk(
    dir: string,
    visit: (absolutePath: string, isDirectory: boolean) => Promise<void>,
  ): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (DOT_PREFIXES.has(entry.name)) continue;
        if (HARD_SKIP.has(entry.name)) continue;
        if (entry.name.startsWith(".")) continue;
        await visit(absolute, true);
        await this.walk(absolute, visit);
      } else {
        await visit(absolute, false);
      }
    }
  }
}
