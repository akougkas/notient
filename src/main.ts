import { Notice, Plugin } from "obsidian";
import { ObsidianFacade } from "./adapters/obsidianFacade";
import { Database } from "./core/db/database";
import { EventBus } from "./core/events/eventBus";
import { GraphStore } from "./core/graph/graphStore";
import { Kernel } from "./core/kernel";
import { LMStudioProvider } from "./core/llm/lmStudioProvider";
import { HealthMonitor } from "./core/services/healthMonitor";
import { VaultLock, type VaultLockHandle } from "./core/services/vaultLock";
import { NotientSettingsTab } from "./core/settings/SettingsTab";
import { SettingsService } from "./core/settings/settingsService";
import { NotientSidebarView, VIEW_TYPE_NOTIENT } from "./ui/sidebar/SidebarView";

const PLUGIN_DIR = ".obsidian/plugins/notient";
const DB_PATH = `${PLUGIN_DIR}/notient.db`;
const WASM_PATH = `${PLUGIN_DIR}/sql-wasm.wasm`;
const LOCK_PATH = `${PLUGIN_DIR}/notient.lock`;

export default class NotientPlugin extends Plugin {
  kernel = new Kernel();
  bus = new EventBus();
  settings!: SettingsService;
  private lockHandle: VaultLockHandle | null = null;

  async onload(): Promise<void> {
    console.log("[Notient] onload");

    this.settings = new SettingsService(this, this.bus);
    await this.settings.load();
    this.addSettingTab(new NotientSettingsTab(this.app, this, this.settings));

    const adapter = this.app.vault.adapter;
    const lock = new VaultLock(
      {
        exists: (path) => adapter.exists(path),
        read: (path) => adapter.read(path),
        writeBinary: (path, data) => adapter.writeBinary(path, data),
        remove: (path) => adapter.remove(path),
      },
      LOCK_PATH,
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );

    try {
      this.lockHandle = await lock.acquire();
    } catch (error) {
      new Notice(`Notient: ${(error as Error).message}`);
      throw error;
    }

    const database = new Database(
      {
        readBinary: async (path) =>
          (await adapter.exists(path)) ? await adapter.readBinary(path) : null,
        writeBinary: (path, data) => adapter.writeBinary(path, data),
      },
      { dbPath: DB_PATH, wasmPath: WASM_PATH },
    );
    await database.init();

    const facade = new ObsidianFacade(this.app);
    const graph = new GraphStore(database);

    const current = this.settings.get();
    const primaryLLM = new LMStudioProvider({ baseUrl: current.primary.baseUrl });
    const deepLLM = new LMStudioProvider({ baseUrl: current.deep.baseUrl });

    const health = new HealthMonitor(
      [
        { label: "primary", baseUrl: current.primary.baseUrl, provider: primaryLLM },
        { label: "deep", baseUrl: current.deep.baseUrl, provider: deepLLM },
      ],
      this.bus,
      { intervalMs: 30_000 },
    );

    this.kernel.register("bus", this.bus);
    this.kernel.register("settings", this.settings);
    this.kernel.register("facade", facade);
    this.kernel.register("database", database);
    this.kernel.register("graph", graph);
    this.kernel.register("primaryLLM", primaryLLM);
    this.kernel.register("deepLLM", deepLLM);
    this.kernel.register("health", health);
    this.kernel.register("lock", this.lockHandle);
    this.kernel.seal();

    this.bus.on("llm:health", () => {
      NotientSidebarView.updateFooter(health.current(), facade.listMarkdown().length);
    });

    health.start();

    this.registerView(VIEW_TYPE_NOTIENT, (leaf) => new NotientSidebarView(leaf));
    this.addRibbonIcon("brain-circuit", "Open Notient", async () => {
      const { workspace } = this.app;
      const existing = workspace.getLeavesOfType(VIEW_TYPE_NOTIENT);
      if (existing.length > 0) {
        workspace.revealLeaf(existing[0]);
        return;
      }
      const leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: VIEW_TYPE_NOTIENT, active: true });
        workspace.revealLeaf(leaf);
      }
    });

    NotientSidebarView.updateFooter(health.current(), facade.listMarkdown().length);
    console.log("[Notient] ready");
  }

  async onunload(): Promise<void> {
    console.log("[Notient] onunload");
    if (this.kernel.isSealed()) {
      try {
        this.kernel.get("health").stop();
      } catch {
        // ignore
      }
      try {
        await this.kernel.get("database").close();
      } catch {
        // ignore
      }
    }
    if (this.lockHandle) {
      try {
        await this.lockHandle.release();
      } catch {
        // ignore
      }
    }
  }
}
