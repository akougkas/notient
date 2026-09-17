import { describe, expect, test } from "bun:test";
import {
  isCanonicalConversationPath,
  isCanonicalOrdinaryNotePath,
  isCanonicalPublicFolderPath,
  isCanonicalPublicNotePath,
  isCanonicalPublicVaultFilePath,
  isNotientOwnedArtifactPath,
} from "../../../../src/core/vault/publicPath";

describe("public vault path contract", () => {
  test.each(["a.md", "Projects/auth.md", "Notient/proposals/new.md", "résumé.md"])(
    "accepts canonical public Markdown note %s",
    (path) => {
      expect(isCanonicalPublicNotePath(path)).toBe(true);
    },
  );

  test.each([
    ".notient/.env",
    ".obsidian/plugins/x.md",
    "notes/.private.md",
    "../outside.md",
    "notes/../../outside.md",
    "/etc/passwd.md",
    "C:\\Users\\me\\note.md",
    "notes\\a.md",
    "notes//a.md",
    "notes/./a.md",
    "notes/a.md/",
    " notes/a.md",
    "notes/a.md ",
    "notes/a\u0000.md",
    "notes/a.txt",
    ".md",
    "",
  ])("rejects noncanonical or nonpublic note path %p", (path) => {
    expect(isCanonicalPublicNotePath(path)).toBe(false);
  });

  test("allows the root and canonical public folders only", () => {
    expect(isCanonicalPublicFolderPath("")).toBe(true);
    expect(isCanonicalPublicFolderPath("Projects/auth")).toBe(true);
    for (const folder of [".notient", "Projects/.private", "../outside", "/tmp", "Projects/"]) {
      expect(isCanonicalPublicFolderPath(folder)).toBe(false);
    }
  });

  test("ordinary note writes reserve Notient-owned artifact roots case-insensitively", () => {
    expect(isCanonicalOrdinaryNotePath("Projects/note.md")).toBe(true);
    for (const path of [
      "Notient/conversations/forged.md",
      "notient/Conversations/forged.md",
      "Notient/proposals/forged.md",
      "NOTIENT/PROPOSALS/forged.md",
    ]) {
      expect(isCanonicalOrdinaryNotePath(path)).toBe(false);
    }
  });

  test("recognizes Notient-owned artifacts case-insensitively without claiming ordinary Notient notes", () => {
    expect(isNotientOwnedArtifactPath("Notient/conversations")).toBe(true);
    expect(isNotientOwnedArtifactPath("notient/CONVERSATIONS/private.md")).toBe(true);
    expect(isNotientOwnedArtifactPath("NOTIENT/proposals/draft.md")).toBe(true);
    expect(isNotientOwnedArtifactPath("Notient/inbox/note.md")).toBe(false);
    expect(isNotientOwnedArtifactPath("Notient/conversations.md")).toBe(false);
  });

  test("accepts canonical public files while conversation paths require one exact direct Markdown child", () => {
    expect(isCanonicalPublicVaultFilePath("Images/photo.png")).toBe(true);
    expect(isCanonicalPublicVaultFilePath("Images/.hidden.png")).toBe(false);
    expect(isCanonicalConversationPath("Notient/conversations/owned.md")).toBe(true);
    expect(isCanonicalConversationPath("notient/conversations/owned.md")).toBe(false);
    expect(isCanonicalConversationPath("Notient/conversations/nested/owned.md")).toBe(false);
    expect(isCanonicalConversationPath("Notient/conversations/owned.txt")).toBe(false);
  });
});
