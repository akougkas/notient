import { generateSearchResultsCanvas } from "../../core/canvas/canvasGenerator";
import type { CanvasFile } from "../../core/canvas/types";
import type { SearchResult } from "../../core/search/types";

/**
 * Exports a {@link SearchResult} as a JSON Canvas file under the saved-queries
 * folder. Filename is `<slug>-<timestamp>.canvas` so multiple exports of the
 * same query coexist without collision. IO is injected so tests can run
 * without booting the Obsidian vault adapter.
 */
export interface CanvasFromResultsFacade {
  ensureFolder(path: string): Promise<void>;
  writeText(path: string, content: string): Promise<void>;
}

export interface CanvasFromResultsOptions {
  facade: CanvasFromResultsFacade;
  /** Saved-queries folder root (e.g. `Notient/searches`). */
  folder: string;
  now: () => number;
}

export interface CanvasExport {
  path: string;
  canvas: CanvasFile;
}

const CANVAS_SUBFOLDER = "canvases";

export class CanvasFromResults {
  constructor(private readonly options: CanvasFromResultsOptions) {}

  async export(result: SearchResult): Promise<CanvasExport> {
    const folder = `${this.options.folder}/${CANVAS_SUBFOLDER}`;
    await this.options.facade.ensureFolder(folder);
    const slug = makeSlug(result.query);
    const path = `${folder}/${slug}-${this.options.now()}.canvas`;
    const canvas = buildCanvas(result);
    await this.options.facade.writeText(path, JSON.stringify(canvas, null, 2));
    return { path, canvas };
  }
}

export function buildCanvas(result: SearchResult): CanvasFile {
  return generateSearchResultsCanvas({
    query: result.query,
    resultPaths: result.hits.map((hit) => hit.notePath),
  });
}

export function makeSlug(query: string): string {
  const slug = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);
  return slug.length > 0 ? slug : "search";
}
