import type { SearchFilters, SearchMode } from "./types";

/**
 * Saved searches are vault-native markdown files. The frontmatter carries the
 * structured query so SearchView can re-run them; the body is human-readable
 * preview text so the file remains useful when opened directly in Obsidian.
 *
 * The store is IO-injected. Callers wire {@link SavedQueriesFacade} to
 * Obsidian's vault adapter in main.ts (Task 16). Tests use an in-memory fake.
 */
export interface SavedQuery {
  id: string;
  query: string;
  mode: SearchMode;
  filters: SearchFilters;
  savedAt: number;
  lastRunAt: number | null;
  notePath: string;
}

export interface SavedQueriesFacade {
  /** Returns markdown file paths inside `folder`. */
  list(folder: string): Promise<string[]>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  delete(path: string): Promise<void>;
}

export interface SavedQueriesOptions {
  facade: SavedQueriesFacade;
  folder: string;
  now: () => number;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n/;

export class SavedQueries {
  constructor(private readonly options: SavedQueriesOptions) {}

  async list(): Promise<SavedQuery[]> {
    const paths = await this.options.facade.list(this.options.folder);
    const result: SavedQuery[] = [];
    for (const path of paths) {
      try {
        const raw = await this.options.facade.read(path);
        const parsed = parseSavedQueryMarkdown(raw, path);
        if (parsed) result.push(parsed);
      } catch {
        // Malformed or unreadable saved-query file: ignore so a single bad
        // file does not poison the whole listing.
      }
    }
    return result.sort((a, b) => b.savedAt - a.savedAt);
  }

  async save(input: {
    query: string;
    mode: SearchMode;
    filters: SearchFilters;
  }): Promise<SavedQuery> {
    const slug = makeSlug(input.query);
    const path = `${this.options.folder}/${slug}.md`;
    const now = this.options.now();
    const saved: SavedQuery = {
      id: slug,
      query: input.query,
      mode: input.mode,
      filters: input.filters,
      savedAt: now,
      lastRunAt: null,
      notePath: path,
    };
    await this.options.facade.write(path, renderSavedQueryMarkdown(saved));
    return saved;
  }

  async touch(id: string): Promise<void> {
    const path = `${this.options.folder}/${id}.md`;
    const raw = await this.options.facade.read(path);
    const parsed = parseSavedQueryMarkdown(raw, path);
    if (!parsed) return;
    parsed.lastRunAt = this.options.now();
    await this.options.facade.write(path, renderSavedQueryMarkdown(parsed));
  }

  async remove(id: string): Promise<void> {
    await this.options.facade.delete(`${this.options.folder}/${id}.md`);
  }
}

export function makeSlug(query: string): string {
  const slug = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
  return slug.length > 0 ? slug : "search";
}

export function parseSavedQueryMarkdown(raw: string, path: string): SavedQuery | null {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return null;
  const fields = parseFlatYaml(match[1] ?? "");
  if (!fields.query || !fields.mode) return null;

  let filters: SearchFilters;
  try {
    filters = JSON.parse(fields.filters ?? "{}") as SearchFilters;
  } catch {
    return null;
  }

  const mode = normalizeMode(fields.mode);
  if (!mode) return null;

  const idFromPath = path.split("/").pop()?.replace(/\.md$/, "") ?? "";
  if (idFromPath.length === 0) return null;

  const savedAt = Number(fields.saved_at ?? "0");
  if (!Number.isFinite(savedAt)) return null;

  const lastRunRaw = fields.last_run_at;
  const lastRunAt =
    lastRunRaw && lastRunRaw !== "null" && Number.isFinite(Number(lastRunRaw))
      ? Number(lastRunRaw)
      : null;

  return {
    id: idFromPath,
    query: stripJsonString(fields.query),
    mode,
    filters,
    savedAt,
    lastRunAt,
    notePath: path,
  };
}

export function renderSavedQueryMarkdown(saved: SavedQuery): string {
  const filtersJson = JSON.stringify(saved.filters);
  const queryJson = JSON.stringify(saved.query);
  const lastRun = saved.lastRunAt === null ? "null" : String(saved.lastRunAt);
  return `---
notient_kind: saved_query
query: ${queryJson}
mode: ${saved.mode}
filters: ${filtersJson}
saved_at: ${saved.savedAt}
last_run_at: ${lastRun}
---

# Search · ${saved.query}

> [!notient-saved-query] ${saved.mode}
> Re-run, edit, or open in SearchView.
`;
}

function parseFlatYaml(yaml: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of yaml.split("\n")) {
    if (line.length === 0) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key.length === 0) continue;
    fields[key] = value;
  }
  return fields;
}

function normalizeMode(value: string): SearchMode | null {
  if (value === "quick" || value === "balanced" || value === "deep") return value;
  return null;
}

function stripJsonString(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value;
    }
  }
  return value;
}
