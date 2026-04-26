/**
 * Environment shim for hnswlib-wasm@0.8.2.
 *
 * The bundled wasm loader runs the following gate at module-evaluation time:
 *
 *     if (!(typeof window == 'object' || typeof importScripts == 'function'))
 *       throw new Error('not compiled for this environment ...');
 *
 * That throws under Bun (and Node) before our TypeScript code can do anything
 * about it. To exercise HnswVectorIndex inside the Bun test runtime we make
 * the gate pass before `hnswlib-wasm` is imported.
 *
 * The shim is a no-op when a real `window` already exists (browsers, Obsidian
 * renderer). The wasm binary itself is embedded as a `data:` URI inside the
 * bundle, so no XHR or filesystem access is needed once the env gate passes.
 *
 * IndexedDB stub: the wasm runtime mounts an IDBFS filesystem and triggers a
 * background sync during init. The bundle's IDBFS helpers attach handlers
 * like `req.onerror = e => callback(this.error)` (an arrow function whose
 * lexical `this` is undefined in strict module mode). In real browsers the
 * success path always fires, so the faulty `this.error` reference never
 * executes. To stay on that success path outside the browser we hand IDBFS
 * an empty in-memory database stub: it yields zero remote entries, the sync
 * reconciles to a no-op, and the wasm continues. We never persist through
 * IDBFS in any environment (HnswVectorIndex serializes raw vectors via its
 * own `persist`/`load`), so failing or no-op-syncing IDBFS is harmless.
 */

interface BrowserShimSurface {
  window: unknown;
  importScripts: (...args: string[]) => void;
  indexedDB: { open(name: string, version?: number): OpenRequestStub };
}

const scope = globalThis as unknown as Partial<BrowserShimSurface>;

if (typeof scope.window === "undefined") {
  scope.window = scope;
}

if (typeof scope.importScripts !== "function") {
  scope.importScripts = () => {
    /* no-op: hnswlib-wasm only checks `typeof importScripts === 'function'` */
  };
}

interface CursorRequest {
  onsuccess: ((event: { target: { result: null } }) => void) | null;
}

interface ObjectStoreStub {
  index(_name: string): { openKeyCursor(): CursorRequest };
  get(_path: string): {
    onsuccess: ((event: { target: { result: undefined } }) => void) | null;
    onerror: (() => void) | null;
  };
  put(
    _entry: unknown,
    _path: string,
  ): { onsuccess: (() => void) | null; onerror: (() => void) | null };
  delete(_path: string): {
    onsuccess: (() => void) | null;
    onerror: (() => void) | null;
  };
}

interface DatabaseStub {
  objectStoreNames: { contains(_name: string): boolean };
  createObjectStore(_name: string): ObjectStoreStub;
  transaction(
    _stores: string[],
    _mode?: string,
  ): {
    onerror: (() => void) | null;
    oncomplete: (() => void) | null;
    objectStore(_name: string): ObjectStoreStub;
  };
  close(): void;
}

interface OpenRequestStub {
  onerror: ((event: { preventDefault: () => void }) => void) | null;
  onsuccess: ((event: { target: { result: DatabaseStub } }) => void) | null;
  onupgradeneeded:
    | ((event: { target: { result: DatabaseStub; transaction: unknown } }) => void)
    | null;
  result: DatabaseStub | null;
  error: Error | null;
}

function makeEmptyObjectStore(): ObjectStoreStub {
  const cursorRequest: CursorRequest = { onsuccess: null };
  const cursorIndex = {
    openKeyCursor(): CursorRequest {
      queueMicrotask(() => {
        if (cursorRequest.onsuccess) cursorRequest.onsuccess({ target: { result: null } });
      });
      return cursorRequest;
    },
  };
  return {
    index() {
      return cursorIndex;
    },
    get() {
      const request = {
        onsuccess: null as ((event: { target: { result: undefined } }) => void) | null,
        onerror: null as (() => void) | null,
      };
      queueMicrotask(() => {
        if (request.onsuccess) request.onsuccess({ target: { result: undefined } });
      });
      return request;
    },
    put() {
      const request = {
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
      };
      queueMicrotask(() => {
        if (request.onsuccess) request.onsuccess();
      });
      return request;
    },
    delete() {
      const request = {
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
      };
      queueMicrotask(() => {
        if (request.onsuccess) request.onsuccess();
      });
      return request;
    },
  };
}

function makeEmptyDatabase(): DatabaseStub {
  const store = makeEmptyObjectStore();
  return {
    objectStoreNames: { contains: () => true },
    createObjectStore() {
      return store;
    },
    transaction() {
      const transaction = {
        onerror: null as (() => void) | null,
        oncomplete: null as (() => void) | null,
        objectStore() {
          return store;
        },
      };
      queueMicrotask(() => {
        if (transaction.oncomplete) transaction.oncomplete();
      });
      return transaction;
    },
    close() {
      /* no-op */
    },
  };
}

if (typeof scope.indexedDB === "undefined") {
  scope.indexedDB = {
    open(_name: string, _version?: number): OpenRequestStub {
      const database = makeEmptyDatabase();
      const request: OpenRequestStub = {
        onerror: null,
        onsuccess: null,
        onupgradeneeded: null,
        result: database,
        error: null,
      };
      queueMicrotask(() => {
        if (request.onsuccess) request.onsuccess({ target: { result: database } });
      });
      return request;
    },
  };
}

export const hnswEnvShimApplied = true;
