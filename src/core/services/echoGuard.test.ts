import { describe, expect, test } from "bun:test";
import { EchoGuard } from "./echoGuard";

describe("EchoGuard", () => {
  test("take returns false when nothing was marked", () => {
    const guard = new EchoGuard();
    expect(guard.take("a.md", "sha1")).toBe(false);
  });

  test("take returns true once for a marked entry", () => {
    const guard = new EchoGuard();
    guard.mark("a.md", "sha1");
    expect(guard.take("a.md", "sha1")).toBe(true);
    expect(guard.take("a.md", "sha1")).toBe(false);
  });

  test("entries expire after ttl", async () => {
    const guard = new EchoGuard({ ttlMs: 10 });
    guard.mark("a.md", "sha1");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(guard.take("a.md", "sha1")).toBe(false);
  });

  test("size caps at maxEntries (oldest evicted)", () => {
    const guard = new EchoGuard({ maxEntries: 2, ttlMs: 60_000 });
    guard.mark("a.md", "1");
    guard.mark("b.md", "2");
    guard.mark("c.md", "3"); // evicts a@1
    expect(guard.take("a.md", "1")).toBe(false);
    expect(guard.take("b.md", "2")).toBe(true);
    expect(guard.take("c.md", "3")).toBe(true);
  });
});
