#!/usr/bin/env bun
/**
 * Real end-to-end smoke harness for the Notient Coordinator + agents.
 *
 * Drives one cycle of every agent (Linker, Synthesizer, ContradictionHunter,
 * MaturityAdvancer) against an already-indexed vault and prints a tally of
 * proposals staged. Requires the Phase 2 indexer to have already populated
 * the SQLite + HNSW stores under .obsidian/plugins/notient/ in the vault.
 * Bypasses Obsidian. If dynamo is unreachable, the harness exits non-zero.
 *
 * Usage:
 *   bun scripts/smoke-coordinator.ts
 *   SMOKE_VAULT_PATH=/path/to/vault bun scripts/smoke-coordinator.ts
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { ContradictionHunter } from "../src/core/agents/contradictionHunter";
import { Linker } from "../src/core/agents/linker";
import { MaturityAdvancer } from "../src/core/agents/maturityAdvancer";
import { Synthesizer } from "../src/core/agents/synthesizer";
import { Coordinator } from "../src/core/coordinator/coordinator";
import { ReasoningMutex } from "../src/core/coordinator/reasoningMutex";
import { Database, type DatabaseAdapter } from "../src/core/db/database";
import { EventBus } from "../src/core/events/eventBus";
import { LMStudioProvider } from "../src/core/llm/lmStudioProvider";
import { EchoGuard } from "../src/core/services/echoGuard";

const DEFAULT_VAULT = "/mnt/c/Users/akougk/Projects/vaultex";
const DEFAULT_LMSTUDIO_URL = "http://192.168.86.143:1234/v1";
const DEFAULT_REASONING_MODEL = "nemotron-cascade-2-30b-a3b-i1";

const VAULT = process.env.SMOKE_VAULT_PATH ?? DEFAULT_VAULT;
const LMSTUDIO_URL = process.env.SMOKE_LMSTUDIO_URL ?? DEFAULT_LMSTUDIO_URL;
const REASONING_MODEL = process.env.SMOKE_REASONING_MODEL ?? DEFAULT_REASONING_MODEL;

const PLUGIN_DIR = `${VAULT}/.obsidian/plugins/notient`;
const DB_PATH = `${PLUGIN_DIR}/notient.db`;
const WASM_PATH = `${PLUGIN_DIR}/sql-wasm.wasm`;

function makeAdapter(): DatabaseAdapter {
  return {
    readBinary: async (path: string) => {
      try {
        const buf = await readFile(path);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      } catch {
        return null;
      }
    },
    writeBinary: async (path: string, data: ArrayBuffer): Promise<void> => {
      await writeFile(path, Buffer.from(data));
    },
  };
}

async function sha256(input: string): Promise<string> {
  const buffer = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function pickFirstNote(db: Database): string | null {
  const rows = db.query<{ path: string }>(
    "SELECT path FROM notes WHERE word_count >= 100 ORDER BY updated_at DESC LIMIT 1;",
  );
  return rows[0]?.path ?? null;
}

async function main(): Promise<void> {
  if (!existsSync(VAULT)) {
    console.error(`[smoke] vault not found at ${VAULT}`);
    process.exit(1);
  }
  if (!existsSync(DB_PATH)) {
    console.error(`[smoke] notient.db not found at ${DB_PATH}; run smoke:indexer first`);
    process.exit(1);
  }
  if (!existsSync(WASM_PATH)) {
    console.error(`[smoke] sql-wasm.wasm not found at ${WASM_PATH}; run dev/build first`);
    process.exit(1);
  }
  await mkdir(PLUGIN_DIR, { recursive: true });

  const adapter = makeAdapter();
  const db = new Database(adapter, { dbPath: DB_PATH, wasmPath: WASM_PATH });
  await db.init();

  const bus = new EventBus();
  const provider = new LMStudioProvider({ baseUrl: LMSTUDIO_URL });

  const ok = await provider.isAvailable();
  if (!ok) {
    console.error(`[smoke] LMStudio not available at ${LMSTUDIO_URL}`);
    process.exit(1);
  }

  const linker = new Linker({
    db,
    provider,
    reasoningModel: REASONING_MODEL,
    neighborhood: async () => [],
  });
  const synthesizer = new Synthesizer({
    db,
    provider,
    reasoningModel: REASONING_MODEL,
    epsilon: 0.2,
    minClusterSize: 2,
    sinceMs: 0,
  });
  const contradictionHunter = new ContradictionHunter({
    db,
    provider,
    reasoningModel: REASONING_MODEL,
    neighbors: async () => [],
    maxPairs: 3,
  });
  const maturityAdvancer = new MaturityAdvancer({
    db,
    facade: {
      read: async (path: string): Promise<string> =>
        readFile(join(VAULT, path), "utf8"),
      write: async (path: string, body: string): Promise<void> => {
        await writeFile(join(VAULT, path), body, "utf8");
      },
    },
    echoGuard: new EchoGuard(),
    hash: sha256,
  });

  const coordinator = new Coordinator({
    bus,
    db,
    mutex: new ReasoningMutex(),
    agents: { linker, synthesizer, contradictionHunter, maturityAdvancer },
  });

  const tally = { linker: 0, synthesizer: 0, contradictionHunter: 0, maturityAdvancer: 0 };
  bus.on("agent:run-finished", (event) => {
    tally[event.agent as keyof typeof tally] += event.proposals;
    console.log(
      `[smoke] ${event.agent} ok=${event.ok} proposals=${event.proposals} ${event.durationMs}ms${
        event.error ? " error=" + event.error : ""
      }`,
    );
  });

  coordinator.start();

  const seedPath = pickFirstNote(db);
  if (!seedPath) {
    console.warn("[smoke] no notes with word_count >= 100 in db; skipping vault-save trigger");
  } else {
    bus.emit({ type: "vault:note-saved", path: seedPath, sha: "smoke" });
  }
  bus.emit({ type: "user:idle", level: "5m" });
  bus.emit({ type: "user:idle", level: "30m" });

  await coordinator.idle();
  coordinator.stop();
  await db.persist();

  console.log("[smoke] tally", tally);
  const total = tally.linker + tally.synthesizer + tally.contradictionHunter + tally.maturityAdvancer;
  if (total === 0) {
    console.error("[smoke] no proposals staged across any agent; failing");
    process.exit(1);
  }
}

await main();
