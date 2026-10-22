import { describe, it, expect, vi } from "vitest";
import { StateStore } from "../../src/db/store.js";
import type { Pool, PoolClient } from "pg";

describe("Recovery & Retention (StateStore unit)", () => {
  function makeMockPool() {
    const executedQueries: Array<{ sql: string; params?: unknown[] }> = [];

    const mockClient = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        executedQueries.push({ sql, params });
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 3 };
      }),
      release: vi.fn(),
    } as unknown as PoolClient;

    const mockPool = {
      connect: vi.fn(async () => mockClient),
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        executedQueries.push({ sql, params });
        return { rows: [], rowCount: 5 };
      }),
    } as unknown as Pool;

    return { mockPool, mockClient, executedQueries };
  }

  it("sweepStuckRuns transitions runs with expired leases to interrupted within a transaction", async () => {
    const { mockPool, executedQueries } = makeMockPool();
    const store = new StateStore(mockPool, { schema: "synckit" });

    const count = await store.sweepStuckRuns();
    expect(count).toBe(3);

    const sqls = executedQueries.map((q) => q.sql);
    expect(sqls).toContain("BEGIN");
    expect(sqls.some((s) => s.includes("UPDATE \"synckit\".runs") && s.includes("state = 'interrupted'"))).toBe(true);
    expect(sqls.some((s) => s.includes("UPDATE \"synckit\".leases") && s.includes("expires_at < now()"))).toBe(true);
    expect(sqls).toContain("COMMIT");
  });

  it("pruneRuns executes delete query parameterized by olderThanDays", async () => {
    const { mockPool, executedQueries } = makeMockPool();
    const store = new StateStore(mockPool, { schema: "synckit" });

    const count = await store.pruneRuns(30);
    expect(count).toBe(5);

    const query = executedQueries.find((q) => q.sql.includes("DELETE FROM \"synckit\".runs"));
    expect(query).toBeDefined();
    expect(query?.params).toEqual([30]);
    expect(query?.sql).toContain("state IN ('succeeded', 'failed', 'interrupted', 'cancelled')");
  });

  it("pruneEvents executes delete query parameterized by olderThanDays", async () => {
    const { mockPool, executedQueries } = makeMockPool();
    const store = new StateStore(mockPool, { schema: "synckit" });

    const count = await store.pruneEvents(14);
    expect(count).toBe(5);

    const query = executedQueries.find((q) => q.sql.includes("DELETE FROM \"synckit\".run_events"));
    expect(query).toBeDefined();
    expect(query?.params).toEqual([14]);
  });

  it("pruneResolvedDeadLetters deletes only resolved dead letters older than days", async () => {
    const { mockPool, executedQueries } = makeMockPool();
    const store = new StateStore(mockPool, { schema: "synckit" });

    const count = await store.pruneResolvedDeadLetters(7);
    expect(count).toBe(5);

    const query = executedQueries.find((q) => q.sql.includes("DELETE FROM \"synckit\".dead_letters"));
    expect(query).toBeDefined();
    expect(query?.params).toEqual([7]);
    expect(query?.sql).toContain("state = 'resolved'");
  });

  it("pruneDeliveryLedger deletes records older than days", async () => {
    const { mockPool, executedQueries } = makeMockPool();
    const store = new StateStore(mockPool, { schema: "synckit" });

    const count = await store.pruneDeliveryLedger(90);
    expect(count).toBe(5);

    const query = executedQueries.find((q) => q.sql.includes("DELETE FROM \"synckit\".delivery_ledger"));
    expect(query).toBeDefined();
    expect(query?.params).toEqual([90]);
  });
});
