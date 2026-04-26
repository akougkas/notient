export interface VaultBootstrapFacade {
  exists(path: string): Promise<boolean>;
  createFolder(path: string): Promise<void>;
}

export interface VaultBootstrapOptions {
  facade: VaultBootstrapFacade;
}

export interface VaultBootstrapPaths {
  conversationsFolder: string;
  proposalsFolder: string;
  savedQueriesFolder: string;
}

export class VaultBootstrap {
  constructor(private readonly options: VaultBootstrapOptions) {}

  async run(paths: VaultBootstrapPaths): Promise<void> {
    const ordered = collectAncestors([
      paths.conversationsFolder,
      paths.proposalsFolder,
      paths.savedQueriesFolder,
    ]);
    for (const folder of ordered) {
      if (await this.options.facade.exists(folder)) continue;
      await this.options.facade.createFolder(folder);
    }
  }
}

function collectAncestors(paths: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const path of paths) {
    const parts = path.split("/").filter(Boolean);
    for (let index = 1; index <= parts.length; index++) {
      const segment = parts.slice(0, index).join("/");
      if (seen.has(segment)) continue;
      seen.add(segment);
      ordered.push(segment);
    }
  }
  return ordered;
}
