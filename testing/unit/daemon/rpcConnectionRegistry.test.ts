import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  MAX_RPC_CONNECTIONS,
  RPC_HELLO_TIMEOUT_MS,
  RpcConnectionRegistry,
} from "../../../src/daemon/rpc";

class TestConnection {
  destroyCalls = 0;

  destroy(): void {
    this.destroyCalls += 1;
  }
}

describe("RpcConnectionRegistry", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("closes an unauthenticated connection after the hello deadline", () => {
    const registry = new RpcConnectionRegistry<TestConnection>();
    const connection = new TestConnection();

    expect(registry.accept(connection)).toBe(true);
    jest.advanceTimersByTime(RPC_HELLO_TIMEOUT_MS - 1);
    expect(connection.destroyCalls).toBe(0);
    expect(registry.size).toBe(1);

    jest.advanceTimersByTime(1);
    expect(connection.destroyCalls).toBe(1);
    expect(registry.size).toBe(0);
  });

  test("an authenticated connection remains live beyond the hello deadline", () => {
    const registry = new RpcConnectionRegistry<TestConnection>();
    const connection = new TestConnection();

    expect(registry.accept(connection)).toBe(true);
    registry.markAuthenticated(connection);
    jest.advanceTimersByTime(RPC_HELLO_TIMEOUT_MS * 2);

    expect(connection.destroyCalls).toBe(0);
    expect(registry.size).toBe(1);
  });

  test("the 65th connection is closed until a live slot is released", () => {
    const registry = new RpcConnectionRegistry<TestConnection>();
    const admitted = Array.from({ length: MAX_RPC_CONNECTIONS }, () => new TestConnection());
    for (const connection of admitted) expect(registry.accept(connection)).toBe(true);

    const refused = new TestConnection();
    expect(registry.accept(refused)).toBe(false);
    expect(refused.destroyCalls).toBe(1);
    expect(registry.size).toBe(MAX_RPC_CONNECTIONS);

    registry.release(admitted[0]);
    const reconnected = new TestConnection();
    expect(registry.accept(reconnected)).toBe(true);
    expect(reconnected.destroyCalls).toBe(0);
    expect(registry.size).toBe(MAX_RPC_CONNECTIONS);
  });

  test("release cancels the connection's pending hello deadline", () => {
    const registry = new RpcConnectionRegistry<TestConnection>();
    const connection = new TestConnection();

    registry.accept(connection);
    registry.release(connection);
    jest.advanceTimersByTime(RPC_HELLO_TIMEOUT_MS);

    expect(connection.destroyCalls).toBe(0);
    expect(registry.size).toBe(0);
  });

  test("shutdown clears deadlines and refuses later admission", () => {
    const registry = new RpcConnectionRegistry<TestConnection>();
    const unauthenticated = new TestConnection();
    const authenticated = new TestConnection();
    registry.accept(unauthenticated);
    registry.accept(authenticated);
    registry.markAuthenticated(authenticated);

    registry.shutdown();
    jest.advanceTimersByTime(RPC_HELLO_TIMEOUT_MS);

    expect(unauthenticated.destroyCalls).toBe(0);
    expect(authenticated.destroyCalls).toBe(0);

    const lateConnection = new TestConnection();
    expect(registry.accept(lateConnection)).toBe(false);
    expect(lateConnection.destroyCalls).toBe(1);
  });
});
