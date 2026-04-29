import { describe, expect, test } from "bun:test";
import { PriorityQueue } from "./priorityQueue";

describe("PriorityQueue", () => {
  test("dequeues lower priority numbers before higher ones across tiers", () => {
    const queue = new PriorityQueue<string>();
    queue.enqueue("tier-2-a", 2, 100);
    queue.enqueue("tier-0-a", 0, 101);
    queue.enqueue("tier-1-a", 1, 102);
    queue.enqueue("tier-2-b", 2, 103);
    queue.enqueue("tier-0-b", 0, 104);
    queue.enqueue("tier-1-b", 1, 105);

    const order: string[] = [];
    while (!queue.isEmpty()) {
      const value = queue.dequeue();
      if (value !== null) {
        order.push(value);
      }
    }

    expect(order).toEqual(["tier-0-a", "tier-0-b", "tier-1-a", "tier-1-b", "tier-2-a", "tier-2-b"]);
  });

  test("breaks ties on a single priority by enqueuedAt FIFO", () => {
    const queue = new PriorityQueue<string>();
    queue.enqueue("third", 1, 30);
    queue.enqueue("first", 1, 10);
    queue.enqueue("fifth", 1, 50);
    queue.enqueue("second", 1, 20);
    queue.enqueue("fourth", 1, 40);

    const order: string[] = [];
    while (!queue.isEmpty()) {
      const value = queue.dequeue();
      if (value !== null) {
        order.push(value);
      }
    }

    expect(order).toEqual(["first", "second", "third", "fourth", "fifth"]);
  });

  test("breaks ties FIFO even when items arrive out of timestamp order", () => {
    const queue = new PriorityQueue<string>();
    queue.enqueue("late", 0, 999);
    queue.enqueue("early", 0, 1);
    queue.enqueue("middle", 0, 500);

    expect(queue.dequeue()).toBe("early");
    expect(queue.dequeue()).toBe("middle");
    expect(queue.dequeue()).toBe("late");
  });

  test("size and isEmpty reflect enqueue and dequeue transitions", () => {
    const queue = new PriorityQueue<number>();
    expect(queue.size()).toBe(0);
    expect(queue.isEmpty()).toBe(true);

    queue.enqueue(10, 0, 1);
    expect(queue.size()).toBe(1);
    expect(queue.isEmpty()).toBe(false);

    queue.enqueue(20, 1, 2);
    queue.enqueue(30, 2, 3);
    expect(queue.size()).toBe(3);

    queue.dequeue();
    expect(queue.size()).toBe(2);
    expect(queue.isEmpty()).toBe(false);

    queue.dequeue();
    queue.dequeue();
    expect(queue.size()).toBe(0);
    expect(queue.isEmpty()).toBe(true);

    expect(queue.dequeue()).toBeNull();
  });

  test("dequeue on empty queue returns null", () => {
    const queue = new PriorityQueue<string>();
    expect(queue.dequeue()).toBeNull();
  });

  test("countByPriority returns per-tier occupancy", () => {
    const queue = new PriorityQueue<string>();
    queue.enqueue("a", 0, 1);
    queue.enqueue("b", 0, 2);
    queue.enqueue("c", 1, 3);
    queue.enqueue("d", 2, 4);
    queue.enqueue("e", 2, 5);
    queue.enqueue("f", 2, 6);

    expect(queue.countByPriority(0)).toBe(2);
    expect(queue.countByPriority(1)).toBe(1);
    expect(queue.countByPriority(2)).toBe(3);
    expect(queue.countByPriority(3)).toBe(0);

    queue.dequeue();
    expect(queue.countByPriority(0)).toBe(1);
    expect(queue.countByPriority(2)).toBe(3);
  });

  test("remove by predicate re-heapifies and preserves order on later dequeues", () => {
    const queue = new PriorityQueue<string>();
    queue.enqueue("/a.md", 1, 10);
    queue.enqueue("/b.md", 0, 20);
    queue.enqueue("/c.md", 2, 30);
    queue.enqueue("/a.md-dup", 1, 40);
    queue.enqueue("/d.md", 0, 50);
    queue.enqueue("/c.md-dup", 2, 60);

    const removed = queue.remove((value) => value.startsWith("/c"));
    expect(removed).toBe(2);
    expect(queue.size()).toBe(4);
    expect(queue.countByPriority(2)).toBe(0);

    const order: string[] = [];
    while (!queue.isEmpty()) {
      const value = queue.dequeue();
      if (value !== null) {
        order.push(value);
      }
    }
    expect(order).toEqual(["/b.md", "/d.md", "/a.md", "/a.md-dup"]);
  });

  test("remove returns 0 when nothing matches and leaves heap intact", () => {
    const queue = new PriorityQueue<string>();
    queue.enqueue("a", 0, 1);
    queue.enqueue("b", 1, 2);

    const removed = queue.remove((value) => value === "missing");
    expect(removed).toBe(0);
    expect(queue.size()).toBe(2);
    expect(queue.dequeue()).toBe("a");
    expect(queue.dequeue()).toBe("b");
  });

  test("remove can drain queue to empty and accept new entries afterward", () => {
    const queue = new PriorityQueue<string>();
    queue.enqueue("x", 0, 1);
    queue.enqueue("y", 1, 2);
    queue.enqueue("z", 2, 3);

    const removed = queue.remove(() => true);
    expect(removed).toBe(3);
    expect(queue.size()).toBe(0);
    expect(queue.isEmpty()).toBe(true);
    expect(queue.dequeue()).toBeNull();

    queue.enqueue("late-tier-2", 2, 100);
    queue.enqueue("late-tier-0", 0, 101);
    queue.enqueue("late-tier-1", 1, 102);

    expect(queue.dequeue()).toBe("late-tier-0");
    expect(queue.dequeue()).toBe("late-tier-1");
    expect(queue.dequeue()).toBe("late-tier-2");
    expect(queue.dequeue()).toBeNull();
  });
});
