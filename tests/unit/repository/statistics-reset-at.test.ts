import { beforeEach, describe, expect, test, vi } from "vitest";

// dbResultMock controls what every DB chain resolves to when awaited
const dbResultMock = vi.fn<[], unknown>().mockReturnValue([{ total: 0 }]);

// db.execute (raw SQL) resolves from the same programmable result queue
const dbExecuteMock = vi.fn(async () => dbResultMock());

// Build a chainable mock that resolves to dbResultMock() on await
function chain(): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const method of ["select", "from", "where", "groupBy", "limit"]) {
    obj[method] = vi.fn(() => chain());
  }
  obj.execute = dbExecuteMock;
  // Make it thenable so `await db.select().from().where()` works
  // biome-ignore lint/suspicious/noThenProperty: thenable mock for drizzle query chain
  obj.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
    try {
      resolve(dbResultMock());
    } catch (e) {
      reject(e);
    }
  };
  return obj;
}

vi.mock("@/drizzle/db", () => ({
  db: chain(),
}));

// Mock drizzle schema -- preserve all exports so module-level sql`` calls work
vi.mock("@/drizzle/schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/drizzle/schema")>();
  return { ...actual };
});

// Mock logger
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe("statistics resetAt parameter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbResultMock.mockReturnValue([{ total: 0 }]);
  });

  describe("sumUserTotalCost", () => {
    test("with valid resetAt -- queries DB and returns cost", async () => {
      const resetAt = new Date("2026-02-15T00:00:00Z");
      dbResultMock.mockReturnValue([{ total: 42.5 }]);

      const { sumUserTotalCost } = await import("@/repository/statistics");
      const result = await sumUserTotalCost(10, 365, resetAt);

      expect(result).toBe(42.5);
      expect(dbResultMock).toHaveBeenCalled();
    });

    test("without resetAt -- uses maxAgeDays cutoff instead", async () => {
      dbResultMock.mockReturnValue([{ total: 100.0 }]);

      const { sumUserTotalCost } = await import("@/repository/statistics");
      const result = await sumUserTotalCost(10, 365);

      expect(result).toBe(100.0);
      expect(dbResultMock).toHaveBeenCalled();
    });

    test("with null resetAt -- treated same as undefined", async () => {
      dbResultMock.mockReturnValue([{ total: 50.0 }]);

      const { sumUserTotalCost } = await import("@/repository/statistics");
      const result = await sumUserTotalCost(10, 365, null);

      expect(result).toBe(50.0);
      expect(dbResultMock).toHaveBeenCalled();
    });

    test("with invalid Date (NaN) -- skips resetAt, falls through to maxAgeDays", async () => {
      const invalidDate = new Date("invalid");
      dbResultMock.mockReturnValue([{ total: 75.0 }]);

      const { sumUserTotalCost } = await import("@/repository/statistics");
      const result = await sumUserTotalCost(10, 365, invalidDate);

      expect(result).toBe(75.0);
      expect(dbResultMock).toHaveBeenCalled();
    });
  });

  describe("sumKeyTotalCost", () => {
    test("with valid resetAt -- uses resetAt instead of maxAgeDays cutoff", async () => {
      const resetAt = new Date("2026-02-20T00:00:00Z");
      dbResultMock.mockReturnValue([{ total: 15.0 }]);

      const { sumKeyTotalCost } = await import("@/repository/statistics");
      const result = await sumKeyTotalCost("sk-hash", 365, resetAt);

      expect(result).toBe(15.0);
      expect(dbResultMock).toHaveBeenCalled();
    });

    test("without resetAt -- falls back to maxAgeDays", async () => {
      dbResultMock.mockReturnValue([{ total: 30.0 }]);

      const { sumKeyTotalCost } = await import("@/repository/statistics");
      const result = await sumKeyTotalCost("sk-hash", 365);

      expect(result).toBe(30.0);
      expect(dbResultMock).toHaveBeenCalled();
    });
  });

  describe("sumUserTotalCostBatch", () => {
    test("with resetAtMap -- aggregates reset users in one statement, batch for the rest", async () => {
      const resetAtMap = new Map([[10, new Date("2026-02-15T00:00:00Z")]]);
      // Calls: 1) VALUES-join aggregation for reset user 10 (db.execute)
      //        2) batch for user 20 => groupBy => [{ userId: 20, total: 50 }]
      dbResultMock
        .mockReturnValueOnce([{ entity_id: 10, total: 25.0 }])
        .mockReturnValueOnce([{ userId: 20, total: 50.0 }]);

      const { sumUserTotalCostBatch } = await import("@/repository/statistics");
      const result = await sumUserTotalCostBatch([10, 20], 365, resetAtMap);

      expect(result.get(10)).toBe(25.0);
      expect(result.get(20)).toBe(50.0);
      expect(dbExecuteMock).toHaveBeenCalledTimes(1);
    });

    test("many reset users -- still a single aggregation statement (regression #1511)", async () => {
      const userIds = Array.from({ length: 50 }, (_, i) => i + 1);
      const resetAtMap = new Map(userIds.map((id) => [id, new Date("2026-02-15T00:00:00Z")]));
      dbResultMock.mockReturnValue(userIds.map((id) => ({ entity_id: id, total: id })));

      const { sumUserTotalCostBatch } = await import("@/repository/statistics");
      const result = await sumUserTotalCostBatch(userIds, Infinity, resetAtMap);

      expect(dbExecuteMock).toHaveBeenCalledTimes(1);
      expect(result.get(1)).toBe(1);
      expect(result.get(50)).toBe(50);
    });

    test("reset user missing from aggregation rows -- defaults to 0", async () => {
      const resetAtMap = new Map([[10, new Date("2026-02-15T00:00:00Z")]]);
      dbResultMock.mockReturnValueOnce([]);

      const { sumUserTotalCostBatch } = await import("@/repository/statistics");
      const result = await sumUserTotalCostBatch([10], 365, resetAtMap);

      expect(result.get(10)).toBe(0);
    });

    test("with invalid reset date -- treated as batch user, no cutoff aggregation", async () => {
      const resetAtMap = new Map([[10, new Date("invalid")]]);
      dbResultMock.mockReturnValue([{ userId: 10, total: 33.0 }]);

      const { sumUserTotalCostBatch } = await import("@/repository/statistics");
      const result = await sumUserTotalCostBatch([10], 365, resetAtMap);

      expect(result.get(10)).toBe(33.0);
      expect(dbExecuteMock).not.toHaveBeenCalled();
    });

    test("with empty resetAtMap -- single batch query for all users", async () => {
      dbResultMock.mockReturnValue([
        { userId: 10, total: 25.0 },
        { userId: 20, total: 50.0 },
      ]);

      const { sumUserTotalCostBatch } = await import("@/repository/statistics");
      const result = await sumUserTotalCostBatch([10, 20], 365, new Map());

      expect(result.get(10)).toBe(25.0);
      expect(result.get(20)).toBe(50.0);
    });

    test("empty userIds -- returns empty map immediately", async () => {
      const { sumUserTotalCostBatch } = await import("@/repository/statistics");
      const result = await sumUserTotalCostBatch([], 365);

      expect(result.size).toBe(0);
    });
  });

  describe("sumKeyTotalCostBatchByIds", () => {
    test("with resetAtMap -- aggregates reset keys in one statement, batch for the rest", async () => {
      const resetAtMap = new Map([[1, new Date("2026-02-15T00:00:00Z")]]);
      dbResultMock
        // 1) PK lookup: key strings
        .mockReturnValueOnce([
          { id: 1, key: "sk-a" },
          { id: 2, key: "sk-b" },
        ])
        // 2) VALUES-join aggregation for reset key 1 (db.execute)
        .mockReturnValueOnce([{ entity_id: "sk-a", total: 10.0 }])
        // 3) batch for key 2
        .mockReturnValueOnce([{ key: "sk-b", total: 20.0 }]);

      const { sumKeyTotalCostBatchByIds } = await import("@/repository/statistics");
      const result = await sumKeyTotalCostBatchByIds([1, 2], 365, resetAtMap);

      expect(result.get(1)).toBe(10.0);
      expect(result.get(2)).toBe(20.0);
      expect(dbExecuteMock).toHaveBeenCalledTimes(1);
    });

    test("many reset keys -- still a single aggregation statement (regression #1511)", async () => {
      const keyIds = Array.from({ length: 40 }, (_, i) => i + 1);
      const resetAtMap = new Map(keyIds.map((id) => [id, new Date("2026-02-15T00:00:00Z")]));
      dbResultMock
        // 1) PK lookup: key strings
        .mockReturnValueOnce(keyIds.map((id) => ({ id, key: `sk-${id}` })))
        // 2) VALUES-join aggregation for all reset keys (db.execute)
        .mockReturnValueOnce(keyIds.map((id) => ({ entity_id: `sk-${id}`, total: id })));

      const { sumKeyTotalCostBatchByIds } = await import("@/repository/statistics");
      const result = await sumKeyTotalCostBatchByIds(keyIds, Infinity, resetAtMap);

      expect(dbExecuteMock).toHaveBeenCalledTimes(1);
      expect(result.get(1)).toBe(1);
      expect(result.get(40)).toBe(40);
    });

    test("empty keyIds -- returns empty map immediately", async () => {
      const { sumKeyTotalCostBatchByIds } = await import("@/repository/statistics");
      const result = await sumKeyTotalCostBatchByIds([], 365);

      expect(result.size).toBe(0);
    });
  });

  describe("sumUserQuotaCosts", () => {
    const ranges = {
      range5h: {
        startTime: new Date("2026-03-01T07:00:00Z"),
        endTime: new Date("2026-03-01T12:00:00Z"),
      },
      rangeDaily: {
        startTime: new Date("2026-03-01T00:00:00Z"),
        endTime: new Date("2026-03-01T12:00:00Z"),
      },
      rangeWeekly: {
        startTime: new Date("2026-02-23T00:00:00Z"),
        endTime: new Date("2026-03-01T12:00:00Z"),
      },
      rangeMonthly: {
        startTime: new Date("2026-02-01T00:00:00Z"),
        endTime: new Date("2026-03-01T12:00:00Z"),
      },
    };

    test("with resetAt -- returns correct cost summary", async () => {
      const resetAt = new Date("2026-02-25T00:00:00Z");
      dbResultMock.mockReturnValue([
        {
          cost5h: "1.0",
          costDaily: "2.0",
          costWeekly: "3.0",
          costMonthly: "4.0",
          costTotal: "5.0",
        },
      ]);

      const { sumUserQuotaCosts } = await import("@/repository/statistics");
      const result = await sumUserQuotaCosts(10, ranges, 365, resetAt);

      expect(result.cost5h).toBe(1.0);
      expect(result.costDaily).toBe(2.0);
      expect(result.costWeekly).toBe(3.0);
      expect(result.costMonthly).toBe(4.0);
      expect(result.costTotal).toBe(5.0);
    });

    test("without resetAt -- uses only maxAgeDays cutoff", async () => {
      dbResultMock.mockReturnValue([
        { cost5h: "0", costDaily: "0", costWeekly: "0", costMonthly: "0", costTotal: "0" },
      ]);

      const { sumUserQuotaCosts } = await import("@/repository/statistics");
      const result = await sumUserQuotaCosts(10, ranges, 365);

      expect(result.cost5h).toBe(0);
      expect(result.costTotal).toBe(0);
    });
  });

  describe("sumKeyQuotaCostsById", () => {
    test("with resetAt -- same cutoff logic as sumUserQuotaCosts", async () => {
      const resetAt = new Date("2026-02-25T00:00:00Z");
      const ranges = {
        range5h: {
          startTime: new Date("2026-03-01T07:00:00Z"),
          endTime: new Date("2026-03-01T12:00:00Z"),
        },
        rangeDaily: {
          startTime: new Date("2026-03-01T00:00:00Z"),
          endTime: new Date("2026-03-01T12:00:00Z"),
        },
        rangeWeekly: {
          startTime: new Date("2026-02-23T00:00:00Z"),
          endTime: new Date("2026-03-01T12:00:00Z"),
        },
        rangeMonthly: {
          startTime: new Date("2026-02-01T00:00:00Z"),
          endTime: new Date("2026-03-01T12:00:00Z"),
        },
      };
      // First: getKeyStringByIdCached lookup, then main query
      dbResultMock.mockReturnValueOnce([{ key: "sk-test-hash" }]).mockReturnValueOnce([
        {
          cost5h: "2.0",
          costDaily: "4.0",
          costWeekly: "6.0",
          costMonthly: "8.0",
          costTotal: "10.0",
        },
      ]);

      const { sumKeyQuotaCostsById } = await import("@/repository/statistics");
      const result = await sumKeyQuotaCostsById(42, ranges, 365, resetAt);

      expect(result.cost5h).toBe(2.0);
      expect(result.costTotal).toBe(10.0);
    });
  });

  describe("sumUserCostInTimeRangesBatch", () => {
    test("aggregates per-user time ranges in a single LATERAL query", async () => {
      dbResultMock.mockReturnValueOnce([
        { user_id: 1, total: "12.5" },
        { user_id: 2, total: "0" },
      ]);

      const { sumUserCostInTimeRangesBatch } = await import("@/repository/statistics");
      const start = new Date("2026-11-21T00:00:00Z");
      const end = new Date("2026-11-21T12:00:00Z");
      const result = await sumUserCostInTimeRangesBatch([
        { userId: 1, startTime: start, endTime: end },
        { userId: 2, startTime: start, endTime: end },
        // Clipped start >= end should default to 0 without failing
        { userId: 3, startTime: end, endTime: start },
      ]);

      expect(dbExecuteMock).toHaveBeenCalledTimes(1);
      expect(result.get(1)).toBe(12.5);
      expect(result.get(2)).toBe(0);
      expect(result.get(3)).toBe(0);
    });

    test("returns empty map when entries are empty", async () => {
      const { sumUserCostInTimeRangesBatch } = await import("@/repository/statistics");
      const result = await sumUserCostInTimeRangesBatch([]);
      expect(result.size).toBe(0);
      expect(dbExecuteMock).not.toHaveBeenCalled();
    });
  });

  describe("sumKeyCostInTimeRangesBatch", () => {
    test("aggregates per-key time ranges in a single LATERAL query", async () => {
      dbResultMock.mockReturnValueOnce([
        { key_id: 101, total: "3.25" },
        { key_id: 102, total: "0.75" },
      ]);

      const { sumKeyCostInTimeRangesBatch } = await import("@/repository/statistics");
      const start = new Date("2026-11-21T00:00:00Z");
      const end = new Date("2026-11-21T12:00:00Z");
      const result = await sumKeyCostInTimeRangesBatch([
        { keyId: 101, key: "sk-101", startTime: start, endTime: end },
        { keyId: 102, key: "sk-102", startTime: start, endTime: end },
        { keyId: 103, key: "sk-103", startTime: end, endTime: start },
      ]);

      expect(dbExecuteMock).toHaveBeenCalledTimes(1);
      expect(result.get(101)).toBe(3.25);
      expect(result.get(102)).toBe(0.75);
      expect(result.get(103)).toBe(0);
    });
  });

  describe("sumUserAndKeyTotalCostBatch", () => {
    test("computes both user and key totals in a single query including deleted-key user rows", async () => {
      dbResultMock.mockReturnValueOnce([
        { user_id: 1, key_id: 101, user_cost: "10.1", key_cost: "10.1" },
        { user_id: 1, key_id: 102, user_cost: "5.2", key_cost: "2.0" },
        // Historical cost from a deleted key still contributes to user 1 total
        { user_id: 1, key_id: null, user_cost: "3.7", key_cost: "0" },
        { user_id: 2, key_id: 201, user_cost: "4.5", key_cost: "4.5" },
      ]);

      const { sumUserAndKeyTotalCostBatch } = await import("@/repository/statistics");
      const result = await sumUserAndKeyTotalCostBatch(
        [
          { userId: 1, resetAt: null },
          { userId: 2, resetAt: new Date("2026-10-01T00:00:00Z") },
          { userId: 3, resetAt: null },
        ],
        [
          { keyId: 101, key: "sk-101", resetAt: null },
          { keyId: 102, key: "sk-102", resetAt: new Date("2026-11-01T00:00:00Z") },
          { keyId: 201, key: "sk-201", resetAt: new Date("2026-10-01T00:00:00Z") },
        ],
        Infinity
      );

      expect(dbExecuteMock).toHaveBeenCalledTimes(1);
      expect(result.userCosts.get(1)).toBe(19);
      expect(result.userCosts.get(2)).toBe(4.5);
      expect(result.userCosts.get(3)).toBe(0);
      expect(result.keyCosts.get(101)).toBe(10.1);
      expect(result.keyCosts.get(102)).toBe(2);
      expect(result.keyCosts.get(201)).toBe(4.5);
    });

    test("pushes earliest cutoff into WHERE when all targets are bounded", async () => {
      dbResultMock.mockReturnValueOnce([
        { user_id: 1, key_id: 101, user_cost: "7.25", key_cost: "7.25" },
      ]);

      const { sumUserAndKeyTotalCostBatch } = await import("@/repository/statistics");
      const result = await sumUserAndKeyTotalCostBatch(
        [{ userId: 1, resetAt: new Date("2026-10-01T00:00:00Z") }],
        [{ keyId: 101, key: "sk-101", resetAt: new Date("2026-10-15T00:00:00Z") }],
        Infinity
      );

      expect(dbExecuteMock).toHaveBeenCalledTimes(1);
      expect(result.userCosts.get(1)).toBe(7.25);
      expect(result.keyCosts.get(101)).toBe(7.25);
    });

    test("returns empty maps when both users and keys are empty", async () => {
      const { sumUserAndKeyTotalCostBatch } = await import("@/repository/statistics");
      const result = await sumUserAndKeyTotalCostBatch([], [], Infinity);
      expect(result.userCosts.size).toBe(0);
      expect(result.keyCosts.size).toBe(0);
      expect(dbExecuteMock).not.toHaveBeenCalled();
    });
  });
});
