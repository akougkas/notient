import { describe, expect, test } from "bun:test";
import { AwakenRunner, type AwakenRunnerArgs } from "./awakenRunner";

function makeArgs(overrides: Partial<AwakenRunnerArgs> = {}): AwakenRunnerArgs {
  const indexed: string[] = [];
  return {
    listMarkdown: () => Array.from({ length: 5 }, (_, i) => ({ path: `/n${i}.md`, mtime: 0 })),
    indexNote: async (path: string) => {
      indexed.push(path);
    },
    batchSize: 2,
    ...overrides,
    indexedRef: indexed,
  } as AwakenRunnerArgs & { indexedRef: string[] };
}

describe("AwakenRunner", () => {
  test("indexes all notes and reports complete with totals", async () => {
    const args = makeArgs();
    const progressEvents: Array<{ processed: number; total: number }> = [];
    const completedRef: { value: { totalIndexed: number } | null } = { value: null };
    const runner = new AwakenRunner(args);
    await runner.start({
      onProgress: (p) => progressEvents.push(p),
      onComplete: (c) => {
        completedRef.value = c;
      },
      onError: () => {},
    });
    expect((args as unknown as { indexedRef: string[] }).indexedRef).toHaveLength(5);
    expect(progressEvents.at(-1)).toEqual({ processed: 5, total: 5 });
    expect(completedRef.value).not.toBeNull();
    expect(completedRef.value?.totalIndexed).toBe(5);
  });

  test("stop halts further batches", async () => {
    const indexed: string[] = [];
    let count = 0;
    const runner = new AwakenRunner({
      listMarkdown: () => Array.from({ length: 20 }, (_, i) => ({ path: `/n${i}.md`, mtime: 0 })),
      indexNote: async (path) => {
        indexed.push(path);
        count++;
        if (count === 4) runner.stop();
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
      batchSize: 2,
    });
    await runner.start({
      onProgress: () => {},
      onComplete: () => {},
      onError: () => {},
    });
    expect(indexed.length).toBeLessThanOrEqual(6);
  });

  test("survives a single failing note and continues", async () => {
    const errors: string[] = [];
    const runner = new AwakenRunner({
      listMarkdown: () => Array.from({ length: 4 }, (_, i) => ({ path: `/n${i}.md`, mtime: 0 })),
      indexNote: async (path) => {
        if (path === "/n2.md") throw new Error("nope");
      },
      batchSize: 2,
    });
    let completed = false;
    await runner.start({
      onProgress: () => {},
      onComplete: () => {
        completed = true;
      },
      onError: (e) => errors.push(e.path),
    });
    expect(completed).toBe(true);
    expect(errors).toEqual(["/n2.md"]);
  });

  test("isRunning reflects state", async () => {
    let release: (() => void) | null = null;
    const runner = new AwakenRunner({
      listMarkdown: () => [{ path: "/a.md", mtime: 0 }],
      indexNote: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      batchSize: 1,
    });
    const promise = runner.start({
      onProgress: () => {},
      onComplete: () => {},
      onError: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(runner.isRunning()).toBe(true);
    if (release) (release as () => void)();
    await promise;
    expect(runner.isRunning()).toBe(false);
  });
});
