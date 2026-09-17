import { describe, expect, test } from "bun:test";
import { normalizeVaultPath } from "../../../../src/core/vault/paths";

describe("normalizeVaultPath", () => {
  test("leaves an absolute posix path alone", () => {
    expect(normalizeVaultPath("/home/me/vault", "/cwd")).toBe("/home/me/vault");
  });

  test("resolves a relative path against cwd", () => {
    expect(normalizeVaultPath("notes/vault", "/cwd")).toBe("/cwd/notes/vault");
  });

  test("trims surrounding whitespace before resolving", () => {
    expect(normalizeVaultPath("  /home/me/vault  ", "/cwd")).toBe("/home/me/vault");
  });

  test("maps a windows drive path onto its wsl mount", () => {
    expect(normalizeVaultPath("C:\\Users\\me\\vaultex", "/cwd")).toBe("/mnt/c/Users/me/vaultex");
  });

  test("lowercases the drive letter and accepts forward slashes", () => {
    expect(normalizeVaultPath("D:/Notes/vault", "/cwd")).toBe("/mnt/d/Notes/vault");
  });

  test("a windows path and its wsl spelling normalise to the same string", () => {
    expect(normalizeVaultPath("C:\\Users\\me\\vaultex", "/cwd")).toBe(
      normalizeVaultPath("/mnt/c/Users/me/vaultex", "/cwd"),
    );
  });
});
