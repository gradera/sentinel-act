// Shared mock neo4j-driver Session/ManagedTransaction/Driver builder used
// by every unit test in this package (spec §10: unit tests use "mocked
// neo4j-driver session/transaction objects", never a real database).
import { vi } from "vitest";
import type { Driver, ManagedTransaction, Session } from "neo4j-driver";

export interface MockRecord {
  get(key: string): unknown;
}

export function mockRecord(data: Record<string, unknown>): MockRecord {
  return { get: (key: string) => data[key] };
}

export interface RunCall {
  cypher: string;
  params: Record<string, unknown>;
}

export interface MockRunResult {
  records: MockRecord[];
}

export type RunHandler = (cypher: string, params: Record<string, unknown>) => MockRunResult | Promise<MockRunResult>;

export interface MockDriverHandle {
  driver: Driver;
  /** Every `tx.run(cypher, params)` call across every session/transaction
   *  opened off this mock driver, in order — assert against this for
   *  "exact Cypher sequence" style spec requirements. */
  calls: RunCall[];
  /** Number of times `session.executeWrite` was invoked across every
   *  session opened off this mock driver — GraphWriter.commitProposal
   *  must open exactly one of these per plan (spec §10). */
  executeWriteCallCount: () => number;
  /** Number of times `driver.session()` was called. */
  sessionCallCount: () => number;
}

const EMPTY_RESULT: MockRunResult = { records: [] };

/**
 * Builds a mock Driver whose `session()` returns a mock Session backed by
 * `handler` for every `tx.run(...)` call, across both `executeRead` and
 * `executeWrite`. `handler` receives the exact Cypher string and params
 * object passed to `.run()` and returns the fake result records.
 *
 * If `handler` is omitted, every `.run()` call returns an empty result set
 * — useful for tests that only care about *what* was run, not what comes
 * back.
 */
export function createMockDriver(handler: RunHandler = () => EMPTY_RESULT): MockDriverHandle {
  const calls: RunCall[] = [];
  let executeWriteCalls = 0;
  let sessionCalls = 0;

  function buildTransaction(): ManagedTransaction {
    return {
      run: vi.fn(async (cypher: string, params: Record<string, unknown> = {}) => {
        calls.push({ cypher, params });
        return handler(cypher, params);
      })
    } as unknown as ManagedTransaction;
  }

  function buildSession(): Session {
    return {
      executeWrite: vi.fn(async (work: (tx: ManagedTransaction) => unknown, _config?: unknown) => {
        executeWriteCalls += 1;
        return work(buildTransaction());
      }),
      executeRead: vi.fn(async (work: (tx: ManagedTransaction) => unknown) => {
        return work(buildTransaction());
      }),
      close: vi.fn(async () => undefined)
    } as unknown as Session;
  }

  const driver = {
    session: vi.fn(() => {
      sessionCalls += 1;
      return buildSession();
    })
  } as unknown as Driver;

  return {
    driver,
    calls,
    executeWriteCallCount: () => executeWriteCalls,
    sessionCallCount: () => sessionCalls
  };
}
