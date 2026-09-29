import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { notePathSchema, revisionSchema } from "../../api/schema";

const privateSourceSchema = z.object({
  id: z.string().uuid(),
  path: notePathSchema,
  revision: revisionSchema.nullable(),
  state: z.enum(["changed", "deleted"]),
  observedAt: z.number().int().nonnegative(),
  inventory: revisionSchema.nullable(),
  afterPath: notePathSchema.nullable(),
  blockedInventory: revisionSchema.nullable(),
  attempt: z.number().int().nonnegative(),
  inFlight: z
    .object({
      jobId: z.string().uuid(),
      inventory: revisionSchema,
      afterPath: notePathSchema.nullable(),
      complete: z.boolean(),
      attempt: z.number().int().nonnegative(),
      startedAt: z.number().int().nonnegative(),
    })
    .strict()
    .nullable(),
}).strict();

const scanCursorSchema = z.object({
  key: z.string().min(1).max(64),
  inventory: revisionSchema,
  afterPath: notePathSchema.nullable(),
  remaining: z.number().int().nonnegative().max(1000000).default(0),
  cycleFound: z.boolean().default(false),
  complete: z.boolean().default(false),
}).strict();

const saveTriggerSchema = z.object({
  path: notePathSchema,
  at: z.number().int().nonnegative(),
}).strict();

const privateStateSchema = z.object({
  version: z.literal(1),
  sources: z.array(privateSourceSchema).max(4096),
  scanCursors: z.array(scanCursorSchema).max(16).default([]),
  saves: z.array(saveTriggerSchema).max(4096).default([]),
}).strict();

export type PendingSourceAttention = z.infer<typeof privateSourceSchema>;
type PrivateState = z.infer<typeof privateStateSchema>;
type ScanCursor = z.infer<typeof scanCursorSchema>;

const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;
const maxStateBytes = 4 * 1024 * 1024;

export class PendingSourceAttentionStore {
  private state: PrivateState = { version: 1, sources: [], scanCursors: [], saves: [] };
  private loaded: Promise<void> | null = null;
  private serial: Promise<void> = Promise.resolve();

  constructor(private readonly path?: string) {}

  list(): Promise<PendingSourceAttention[]> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      return this.state.sources.map((source) => structuredClone(source));
    });
  }

  saveTriggers(): Promise<Array<{ path: string; at: number }>> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      return this.state.saves.map((save) => ({ ...save }));
    });
  }

  recordSave(path: string, at: number): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const saves = this.state.saves.filter((save) => save.path !== path);
      saves.push({ path, at });
      await this.commit({ ...this.state, saves: saves.slice(-4096) });
    });
  }

  pruneSaves(olderThan: number): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const saves = this.state.saves.filter((save) => save.at >= olderThan);
      if (saves.length === this.state.saves.length) return;
      await this.commit({ ...this.state, saves });
    });
  }

  scanCursor(key: string, inventory: string): Promise<ScanCursor | null> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const cursor = this.state.scanCursors.find((entry) => entry.key === key);
      return cursor?.inventory === inventory ? structuredClone(cursor) : null;
    });
  }

  advanceScanCursor(
    key: string,
    input: {
      inventory: string;
      afterPath: string | null;
      remaining: number;
      cycleFound: boolean;
      complete: boolean;
    },
  ): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const next: ScanCursor = scanCursorSchema.parse({ key, ...input });
      const scanCursors = this.state.scanCursors.filter((entry) => entry.key !== key);
      scanCursors.push(next);
      await this.commit({ ...this.state, scanCursors: scanCursors.slice(-16) });
    });
  }

  record(path: string, revision: string | null, state: "changed" | "deleted", observedAt: number): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const current = this.state.sources.find((source) => source.path === path);
      const resolvedRevision = state === "deleted" ? null : revision ?? current?.revision ?? null;
      const sameEvent =
        current !== undefined &&
        current.state === state &&
        revision !== null &&
        revision !== undefined &&
        current.revision === resolvedRevision;
      const next: PendingSourceAttention = sameEvent
        ? {
            ...current,
            revision: resolvedRevision,
            observedAt: Math.max(current.observedAt, observedAt),
          }
        : {
            id: randomUUID(),
            path,
            revision: resolvedRevision,
            state,
            observedAt,
            inventory: null,
            afterPath: null,
            blockedInventory: null,
            attempt: 0,
            inFlight: null,
          };
      const sources = this.state.sources.filter((source) => source.path !== path);
      sources.push(next);
      await this.commit({ ...this.state, sources });
    });
  }

  completePage(
    eventId: string,
    progress: {
      inventory: string;
      afterPath: string | null;
      complete: boolean;
      blocked?: boolean;
      blockedInventory?: string;
    },
  ): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const current = this.state.sources.find((source) => source.id === eventId);
      if (!current) return;
      const sources = this.state.sources.filter((source) => source.id !== eventId);
      if (!progress.complete) {
        sources.push({
          ...current,
          inventory: progress.inventory,
          afterPath: progress.afterPath,
          blockedInventory: progress.blocked ? progress.blockedInventory ?? progress.inventory : null,
          attempt: 0,
          inFlight: null,
        });
      }
      await this.commit({ ...this.state, sources });
    });
  }

  beginPage(
    eventId: string,
    input: {
      jobId: string;
      inventory: string;
      afterPath: string | null;
      complete: boolean;
      startedAt: number;
    },
  ): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const current = this.state.sources.find((source) => source.id === eventId);
      if (!current) return;
      await this.commit({
        ...this.state,
        sources: this.state.sources.map((source) =>
          source.id === eventId
            ? {
                ...source,
                inFlight: { ...input, attempt: source.attempt },
              }
            : source,
        ),
      });
    });
  }

  finishPage(eventId: string, finished: boolean, blockedInventory?: string): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const current = this.state.sources.find((source) => source.id === eventId);
      if (!current?.inFlight) return;
      const inFlight = current.inFlight;
      if (finished) {
        const sources = this.state.sources.filter((source) => source.id !== eventId);
        if (!inFlight.complete) {
          sources.push({
            ...current,
            inventory: inFlight.inventory,
            afterPath: inFlight.afterPath,
            blockedInventory: null,
            attempt: 0,
            inFlight: null,
          });
        }
        await this.commit({ ...this.state, sources });
        return;
      }
      await this.commit({
        ...this.state,
        sources: this.state.sources.map((source) =>
          source.id === eventId
            ? {
                ...source,
                blockedInventory: blockedInventory ?? inFlight.inventory,
                inFlight: null,
              }
            : source,
        ),
      });
    });
  }

  unblockChangedInventory(inventory: string | readonly string[]): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const currentInventories = new Set(Array.isArray(inventory) ? inventory : [inventory]);
      if (
        !this.state.sources.some(
          (source) => source.blockedInventory !== null && !currentInventories.has(source.blockedInventory),
        )
      )
        return;
      await this.commit({
        ...this.state,
        sources: this.state.sources.map((source) =>
          source.blockedInventory !== null && !currentInventories.has(source.blockedInventory)
            ? { ...source, blockedInventory: null }
            : source,
        ),
      });
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation);
    this.serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.path) return;
    if (!this.loaded) this.loaded = this.readState();
    await this.loaded;
  }

  private async readState(): Promise<void> {
    const directory = dirname(this.path!);
    const dir = await openPrivateDirectory(directory);
    try {
      let handle;
      try {
        handle = await open(this.path!, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      try {
        const stat = await handle.stat();
        assertOwned(stat, "pending source state");
        if (!stat.isFile() || (stat.mode & 0o7777) !== privateFileMode || stat.size > maxStateBytes)
          throw new Error("pending source state must be a bounded mode-0600 regular file");
        const linked = await lstat(this.path!);
        if (!sameFile(stat, linked) || linked.isSymbolicLink())
          throw new Error("pending source state changed while being read");
        const parsed = privateStateSchema.parse(JSON.parse(await handle.readFile("utf8")));
        this.state = parsed;
      } finally {
        await handle.close();
      }
    } finally {
      await dir.close();
    }
  }

  private async commit(input: unknown): Promise<void> {
    const next = privateStateSchema.parse(input);
    if (this.path) await writePrivateState(this.path, next);
    this.state = next;
  }
}

async function openPrivateDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const stat = await handle.stat();
  assertOwned(stat, "pending source state directory");
  if (!stat.isDirectory() || (stat.mode & 0o7777) !== privateDirectoryMode) {
    await handle.close();
    throw new Error("pending source state directory must be mode 0700");
  }
  const linked = await lstat(path);
  if (!sameFile(stat, linked) || linked.isSymbolicLink()) {
    await handle.close();
    throw new Error("pending source state directory changed while being opened");
  }
  return handle;
}

async function writePrivateState(path: string, state: PrivateState): Promise<void> {
  const directoryPath = dirname(path);
  const directory = await openPrivateDirectory(directoryPath);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const body = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(body) > maxStateBytes) throw new Error("pending source state exceeds its byte limit");
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      privateFileMode,
    );
    try {
      await handle.writeFile(body, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await directory.sync();
  } finally {
    await rm(temporary, { force: true });
    await directory.close();
  }
}

function assertOwned(stat: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>, label: string): void {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${label} is owned by an unexpected user`);
  }
}

function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
