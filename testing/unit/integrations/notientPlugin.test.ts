import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { VERSION } from "../../../src/version";

const ROOT = resolve(import.meta.dir, "../../..");

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(ROOT, path), "utf8")) as Record<string, unknown>;
}

describe("Notient agent plugin", () => {
  test("both marketplaces resolve the same plugin and the package ships it", async () => {
    const codexMarketplace = await json(".agents/plugins/marketplace.json");
    const claudeMarketplace = await json(".claude-plugin/marketplace.json");
    const packageJson = await json("package.json");
    const codexManifest = await json("plugins/notient/.codex-plugin/plugin.json");
    const claudeManifest = await json("plugins/notient/.claude-plugin/plugin.json");

    expect(codexMarketplace.name).toBe("notient");
    expect(codexMarketplace.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "notient",
          source: { source: "local", path: "./plugins/notient" },
        }),
      ]),
    );
    expect(claudeMarketplace.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "notient",
          source: "./plugins/notient",
          version: VERSION,
        }),
      ]),
    );
    expect(claudeMarketplace.metadata).toEqual(expect.objectContaining({ version: VERSION }));
    expect(packageJson.version).toBe(VERSION);
    expect(codexManifest.version).toBe(VERSION);
    expect(claudeManifest.version).toBe(VERSION);
    expect(packageJson.files).toEqual(
      expect.arrayContaining(["plugins", ".agents", ".claude-plugin", "docs/agents.md"]),
    );
  });

  test("host adapters keep distinct authenticated visitor identities", async () => {
    const codexManifest = await json("plugins/notient/.codex-plugin/plugin.json");
    const claudeMcp = await json("plugins/notient/.mcp.json");

    expect(codexManifest.mcpServers).toEqual({
      notient: {
        command: "notient",
        args: ["mcp", "--as", "codex"],
        env_vars: ["NOTIENT_VAULT"],
      },
    });
    expect(claudeMcp.mcpServers).toEqual({
      notient: { command: "notient", args: ["mcp", "--as", "claude-code"] },
    });
  });

  test("the installable skill is the sole behavioral authority", async () => {
    const canonical = await readFile(
      resolve(ROOT, "plugins/notient/skills/notient/SKILL.md"),
      "utf8",
    );
    const docsPointer = await readFile(resolve(ROOT, "docs/skills/notient.md"), "utf8");

    expect(canonical).toContain("name: notient");
    expect(canonical).toMatch(/Markdown\s+is durable; models and hosts are transient visitors\./);
    expect(docsPointer).toContain("plugins/notient/skills/notient/SKILL.md");
    expect(docsPointer).not.toContain("## Propose durable changes once");
  });
});
