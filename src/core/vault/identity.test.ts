import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import path from "node:path";
import {
  vaultDataDir,
  vaultId,
  vaultPidPath,
  vaultPortPath,
  vaultSecretPath,
  vaultStateDir,
} from "./identity";

describe("vaultId", () => {
  test("is deterministic for the same path", () => {
    const input = "/tmp/example-vault";
    expect(vaultId(input)).toBe(vaultId(input));
  });

  test("returns 16 lowercase hex characters", () => {
    const id = vaultId("/tmp/example-vault");
    expect(id).toHaveLength(16);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  test("different absolute paths produce different ids", () => {
    const first = vaultId("/tmp/vault-one");
    const second = vaultId("/tmp/vault-two");
    expect(first).not.toBe(second);
  });

  test("normalises relative paths via path.resolve", () => {
    expect(vaultId("foo")).toBe(vaultId(path.resolve("foo")));
  });
});

describe("vault path helpers", () => {
  const input = "/tmp/example-vault";
  const root = path.join(homedir(), ".notient", vaultId(input));

  test("vaultStateDir composes under ~/.notient/<id>/", () => {
    expect(vaultStateDir(input)).toBe(root);
    expect(vaultStateDir(input).startsWith(root)).toBe(true);
  });

  test("vaultDataDir composes under ~/.notient/<id>/", () => {
    expect(vaultDataDir(input)).toBe(path.join(root, "data"));
    expect(vaultDataDir(input).startsWith(root)).toBe(true);
  });

  test("vaultSecretPath composes under ~/.notient/<id>/", () => {
    expect(vaultSecretPath(input)).toBe(path.join(root, "secret.key"));
    expect(vaultSecretPath(input).startsWith(root)).toBe(true);
  });

  test("vaultPortPath composes under ~/.notient/<id>/", () => {
    expect(vaultPortPath(input)).toBe(path.join(root, "surreal.port"));
    expect(vaultPortPath(input).startsWith(root)).toBe(true);
  });

  test("vaultPidPath composes under ~/.notient/<id>/", () => {
    expect(vaultPidPath(input)).toBe(path.join(root, "surreal.pid"));
    expect(vaultPidPath(input).startsWith(root)).toBe(true);
  });
});
