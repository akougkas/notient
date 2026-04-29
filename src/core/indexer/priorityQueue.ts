/**
 * Generic min-heap priority queue. Lower priority numbers dequeue first; ties
 * break FIFO via the caller-supplied enqueuedAt timestamp.
 */

interface HeapEntry<T> {
  value: T;
  priority: number;
  enqueuedAt: number;
}

export class PriorityQueue<T> {
  private heap: HeapEntry<T>[] = [];

  enqueue(value: T, priority: number, enqueuedAt: number): void {
    this.heap.push({ value, priority, enqueuedAt });
    this.siftUp(this.heap.length - 1);
  }

  dequeue(): T | null {
    if (this.heap.length === 0) {
      return null;
    }
    const top = this.heap[0];
    const last = this.heap.pop();
    if (last !== undefined && this.heap.length > 0) {
      this.heap[0] = last;
      this.siftDown(0);
    }
    return top.value;
  }

  size(): number {
    return this.heap.length;
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  countByPriority(priority: number): number {
    let total = 0;
    for (const entry of this.heap) {
      if (entry.priority === priority) {
        total++;
      }
    }
    return total;
  }

  remove(predicate: (value: T) => boolean): number {
    const kept: HeapEntry<T>[] = [];
    let removed = 0;
    for (const entry of this.heap) {
      if (predicate(entry.value)) {
        removed++;
      } else {
        kept.push(entry);
      }
    }
    if (removed === 0) {
      return 0;
    }
    this.heap = kept;
    this.heapify();
    return removed;
  }

  private compare(a: HeapEntry<T>, b: HeapEntry<T>): number {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    return a.enqueuedAt - b.enqueuedAt;
  }

  private siftUp(start: number): void {
    let current = start;
    while (current > 0) {
      const parent = (current - 1) >> 1;
      if (this.compare(this.heap[current], this.heap[parent]) < 0) {
        const temporary = this.heap[current];
        this.heap[current] = this.heap[parent];
        this.heap[parent] = temporary;
        current = parent;
      } else {
        break;
      }
    }
  }

  private siftDown(start: number): void {
    const length = this.heap.length;
    let current = start;
    while (true) {
      const left = current * 2 + 1;
      const right = current * 2 + 2;
      let smallest = current;
      if (left < length && this.compare(this.heap[left], this.heap[smallest]) < 0) {
        smallest = left;
      }
      if (right < length && this.compare(this.heap[right], this.heap[smallest]) < 0) {
        smallest = right;
      }
      if (smallest === current) {
        break;
      }
      const temporary = this.heap[current];
      this.heap[current] = this.heap[smallest];
      this.heap[smallest] = temporary;
      current = smallest;
    }
  }

  private heapify(): void {
    for (let position = (this.heap.length >> 1) - 1; position >= 0; position--) {
      this.siftDown(position);
    }
  }
}
