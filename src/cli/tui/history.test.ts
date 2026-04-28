import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendHistoryToFile,
  createHistoryNav,
  historyAppend,
  historyNext,
  historyPrev,
  historyReset,
  loadHistoryFromFile,
  routeHistoryKey,
} from "./history";

describe("createHistoryNav", () => {
  test("starts with index -1 (at-bottom) and the supplied entries", () => {
    const nav = createHistoryNav(["a", "b", "c"]);
    expect(nav.index).toBe(-1);
    expect(nav.entries).toEqual(["a", "b", "c"]);
  });
});

describe("historyPrev", () => {
  test("from at-bottom returns the newest entry", () => {
    const nav = createHistoryNav(["old", "mid", "new"]);
    const result = historyPrev(nav);
    expect(result.value).toBe("new");
    expect(result.nav.index).toBe(0);
  });

  test("walks back through entries on successive calls", () => {
    let nav = createHistoryNav(["old", "mid", "new"]);
    const first = historyPrev(nav);
    nav = first.nav;
    const second = historyPrev(nav);
    nav = second.nav;
    const third = historyPrev(nav);
    expect(first.value).toBe("new");
    expect(second.value).toBe("mid");
    expect(third.value).toBe("old");
    expect(third.nav.index).toBe(2);
  });

  test("clamps at the oldest entry", () => {
    let nav = createHistoryNav(["only"]);
    const first = historyPrev(nav);
    nav = first.nav;
    const second = historyPrev(nav);
    expect(first.value).toBe("only");
    expect(second.value).toBe("only");
    expect(second.nav.index).toBe(0);
  });

  test("returns null when there are no entries", () => {
    const nav = createHistoryNav([]);
    const result = historyPrev(nav);
    expect(result.value).toBeNull();
    expect(result.nav.index).toBe(-1);
  });
});

describe("historyNext", () => {
  test("walks forward toward the live buffer", () => {
    let nav = createHistoryNav(["a", "b", "c"]);
    nav = historyPrev(nav).nav;
    nav = historyPrev(nav).nav;
    const result = historyNext(nav);
    expect(result.value).toBe("c");
    expect(result.nav.index).toBe(0);
  });

  test("from index 0 returns to the live buffer (empty string)", () => {
    let nav = createHistoryNav(["a", "b"]);
    nav = historyPrev(nav).nav;
    const result = historyNext(nav);
    expect(result.value).toBe("");
    expect(result.nav.index).toBe(-1);
  });

  test("at the live buffer is a no-op (returns null)", () => {
    const nav = createHistoryNav(["a"]);
    const result = historyNext(nav);
    expect(result.value).toBeNull();
    expect(result.nav.index).toBe(-1);
  });
});

describe("historyAppend", () => {
  test("appends a new entry", () => {
    const nav = createHistoryNav(["a", "b"]);
    const next = historyAppend(nav, "c", 100);
    expect(next.entries).toEqual(["a", "b", "c"]);
  });

  test("skips a duplicate of the latest entry", () => {
    const nav = createHistoryNav(["a", "b"]);
    const next = historyAppend(nav, "b", 100);
    expect(next.entries).toEqual(["a", "b"]);
  });

  test("trims to the max when over capacity", () => {
    const nav = createHistoryNav(["a", "b", "c"]);
    const next = historyAppend(nav, "d", 3);
    expect(next.entries).toEqual(["b", "c", "d"]);
  });

  test("ignores empty entries", () => {
    const nav = createHistoryNav(["a"]);
    const next = historyAppend(nav, "", 100);
    expect(next.entries).toEqual(["a"]);
  });

  test("resets index to -1 after append", () => {
    let nav = createHistoryNav(["a", "b"]);
    nav = historyPrev(nav).nav;
    nav = historyAppend(nav, "c", 100);
    expect(nav.index).toBe(-1);
  });
});

describe("historyReset", () => {
  test("returns the navigator at index -1 with entries preserved", () => {
    let nav = createHistoryNav(["a", "b"]);
    nav = historyPrev(nav).nav;
    const reset = historyReset(nav);
    expect(reset.index).toBe(-1);
    expect(reset.entries).toEqual(["a", "b"]);
  });
});

describe("routeHistoryKey", () => {
  test("up with empty buffer claims the key and returns the newest entry", () => {
    const nav = createHistoryNav(["a", "b"]);
    const result = routeHistoryKey({ keyName: "up", nav, buffer: "", inHistory: false });
    expect(result?.value).toBe("b");
    expect(result?.anchor).toBe("b");
  });

  test("up with non-empty buffer and not in history falls through", () => {
    const nav = createHistoryNav(["a", "b"]);
    const result = routeHistoryKey({ keyName: "up", nav, buffer: "x", inHistory: false });
    expect(result).toBeNull();
  });

  test("up while in history claims even with non-empty buffer", () => {
    let nav = createHistoryNav(["a", "b"]);
    nav = historyPrev(nav).nav;
    const result = routeHistoryKey({ keyName: "up", nav, buffer: "b", inHistory: true });
    expect(result?.value).toBe("a");
    expect(result?.anchor).toBe("a");
  });

  test("down outside history mode falls through", () => {
    const nav = createHistoryNav(["a"]);
    const result = routeHistoryKey({ keyName: "down", nav, buffer: "x", inHistory: false });
    expect(result).toBeNull();
  });

  test("down at index 0 returns to live buffer with null anchor", () => {
    let nav = createHistoryNav(["a"]);
    nav = historyPrev(nav).nav;
    const result = routeHistoryKey({ keyName: "down", nav, buffer: "a", inHistory: true });
    expect(result?.value).toBe("");
    expect(result?.anchor).toBeNull();
  });

  test("up on empty entries falls through (cannot enter history)", () => {
    const nav = createHistoryNav([]);
    const result = routeHistoryKey({ keyName: "up", nav, buffer: "", inHistory: false });
    expect(result).toBeNull();
  });

  test("non-up/down key falls through", () => {
    const nav = createHistoryNav(["a"]);
    const result = routeHistoryKey({ keyName: "other", nav, buffer: "", inHistory: false });
    expect(result).toBeNull();
  });
});

describe("history file I/O", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "notient-history-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("loadHistoryFromFile returns [] when the file does not exist", () => {
    const entries = loadHistoryFromFile(join(dir, "missing.txt"), 100);
    expect(entries).toEqual([]);
  });

  test("loadHistoryFromFile returns lines, oldest first, capped to max", () => {
    const path = join(dir, "history.txt");
    writeFileSync(path, "one\ntwo\nthree\nfour\n");
    const entries = loadHistoryFromFile(path, 3);
    expect(entries).toEqual(["two", "three", "four"]);
  });

  test("loadHistoryFromFile drops blank lines", () => {
    const path = join(dir, "history.txt");
    writeFileSync(path, "a\n\nb\n\n");
    expect(loadHistoryFromFile(path, 100)).toEqual(["a", "b"]);
  });

  test("appendHistoryToFile creates the file on first write", () => {
    const path = join(dir, "history.txt");
    appendHistoryToFile(path, "hello", 100);
    expect(readFileSync(path, "utf8")).toBe("hello\n");
  });

  test("appendHistoryToFile appends and truncates to the cap", () => {
    const path = join(dir, "history.txt");
    appendHistoryToFile(path, "a", 3);
    appendHistoryToFile(path, "b", 3);
    appendHistoryToFile(path, "c", 3);
    appendHistoryToFile(path, "d", 3);
    expect(readFileSync(path, "utf8")).toBe("b\nc\nd\n");
  });

  test("appendHistoryToFile skips empty entries", () => {
    const path = join(dir, "history.txt");
    appendHistoryToFile(path, "", 100);
    appendHistoryToFile(path, "  \n  ", 100);
    expect(loadHistoryFromFile(path, 100)).toEqual([]);
  });

  test("appendHistoryToFile skips a duplicate of the last persisted entry", () => {
    const path = join(dir, "history.txt");
    appendHistoryToFile(path, "a", 100);
    appendHistoryToFile(path, "a", 100);
    appendHistoryToFile(path, "b", 100);
    appendHistoryToFile(path, "b", 100);
    expect(readFileSync(path, "utf8")).toBe("a\nb\n");
  });
});
