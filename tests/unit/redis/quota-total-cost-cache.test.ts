import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRedisClient } from "@/lib/redis/client";
import {
  buildQuotaTotalCostCacheKey,
  getUsersAndKeysTotalCostWithCache,
  invalidateQuotaTotalCostCache,
  QUOTA_TOTAL_COST_BASELINE_KEY,
  QUOTA_TOTAL_COST_CACHE_PREFIX,
  QUOTA_TOTAL_COST_GEN_KEY,
  QUOTA_TOTAL_COST_HOT_KEY,
  QUOTA_TOTAL_COST_LOCK_KEY,
} from "@/lib/redis/quota-total-cost-cache";
import {
  sumKeyCostInTimeRangesBatch,
  sumUserAndKeyTotalCostBatch,
  sumUserAndKeyTotalCostWindowBatch,
  sumUserCostInTimeRangesBatch,
} from "@/repository/statistics";

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/redis/client", () => ({
  getRedisClient: vi.fn(),
}));

vi.mock("@/repository/statistics", () => ({
  sumUserAndKeyTotalCostBatch: vi.fn(),
  sumUserAndKeyTotalCostWindowBatch: vi.fn(),
  sumUserCostInTimeRangesBatch: vi.fn(),
  sumKeyCostInTimeRangesBatch: vi.fn(),
}));

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function createRedisMock() {
  return {
    status: "ready",
    get: vi.fn(),
    mget: vi.fn(),
    set: vi.fn(),
    setex: vi.fn(),
    del: vi.fn(),
    incr: vi.fn(),
    eval: vi.fn(),
  };
}

describe("quota-total-cost-cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds deterministic secret-free cache keys sensitive to resetAt", () => {
    const k1 = buildQuotaTotalCostCacheKey(
      [
        { userId: 2, resetAt: null },
        { userId: 1, resetAt: new Date("2026-10-01T00:00:00Z") },
      ],
      [{ keyId: 10, key: "sk-secret-raw-value", resetAt: null }],
      Infinity
    );
    const k2 = buildQuotaTotalCostCacheKey(
      [
        { userId: 1, resetAt: new Date("2026-10-01T00:00:00Z") },
        { userId: 2, resetAt: null },
      ],
      [{ keyId: 10, key: "sk-different-raw-value", resetAt: null }],
      Infinity
    );
    const k3 = buildQuotaTotalCostCacheKey(
      [
        { userId: 1, resetAt: new Date("2026-11-01T00:00:00Z") },
        { userId: 2, resetAt: null },
      ],
      [{ keyId: 10, key: "sk-secret-raw-value", resetAt: null }],
      Infinity
    );

    expect(k1.startsWith(QUOTA_TOTAL_COST_CACHE_PREFIX)).toBe(true);
    expect(k1).not.toContain("sk-secret");
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
  });

  it("returns cached maps on hot Redis hit without querying DB", async () => {
    const redis = createRedisMock();
    const users = [{ userId: 1, resetAt: null }];
    const keys = [{ keyId: 10, key: "sk-10", resetAt: null }];
    const digest = buildQuotaTotalCostCacheKey(users, keys, Infinity);

    redis.mget.mockResolvedValueOnce([
      JSON.stringify({
        digest,
        userCosts: [[1, 42.5]],
        keyCosts: [[10, 12.25]],
      }),
      null,
      null,
    ]);
    vi.mocked(getRedisClient).mockReturnValue(
      redis as unknown as ReturnType<typeof getRedisClient>
    );

    const result = await getUsersAndKeysTotalCostWithCache(users, keys);

    expect(result.userCosts.get(1)).toBe(42.5);
    expect(result.keyCosts.get(10)).toBe(12.25);
    expect(sumUserAndKeyTotalCostWindowBatch).not.toHaveBeenCalled();
    expect(sumUserAndKeyTotalCostBatch).not.toHaveBeenCalled();
  });

  it("builds baseline on cold miss, writes baseline + hot cache, and releases lock with owner token", async () => {
    const redis = createRedisMock();
    redis.mget.mockResolvedValueOnce([null, null, null]);
    redis.set.mockResolvedValueOnce("OK");
    redis.get.mockResolvedValueOnce(null); // gen unchanged
    redis.setex.mockResolvedValue("OK");
    redis.eval.mockResolvedValueOnce(1);
    vi.mocked(getRedisClient).mockReturnValue(
      redis as unknown as ReturnType<typeof getRedisClient>
    );
    vi.mocked(sumUserAndKeyTotalCostWindowBatch).mockResolvedValueOnce({
      settledUserCosts: new Map([[1, 90]]),
      liveUserCosts: new Map([[1, 9.9]]),
      settledKeyCosts: new Map([[10, 45]]),
      liveKeyCosts: new Map([[10, 5.1]]),
    });

    const result = await getUsersAndKeysTotalCostWithCache(
      [{ userId: 1, resetAt: null }],
      [{ keyId: 10, key: "sk-10", resetAt: null }]
    );

    expect(sumUserAndKeyTotalCostWindowBatch).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(sumUserAndKeyTotalCostWindowBatch).mock.calls[0];
    expect(callArgs[2].fromInclusive).toBeUndefined();
    expect(callArgs[2].splitAt).toBeInstanceOf(Date);

    expect(redis.setex).toHaveBeenCalledWith(
      QUOTA_TOTAL_COST_BASELINE_KEY,
      7 * 24 * 60 * 60,
      expect.any(String)
    );
    expect(redis.setex).toHaveBeenCalledWith(QUOTA_TOTAL_COST_HOT_KEY, 15, expect.any(String));
    const [lockKey, lockToken] = redis.set.mock.calls[0] as [string, string];
    expect(lockKey).toBe(QUOTA_TOTAL_COST_LOCK_KEY);
    expect(lockToken.length).toBeGreaterThan(0);
    expect(redis.eval).toHaveBeenCalledWith(expect.any(String), 1, lockKey, lockToken);
    expect(result.userCosts.get(1)).toBe(99.9);
    expect(result.keyCosts.get(10)).toBe(50.1);
  });

  it("uses fast incremental delta query when hot cache expired but baseline exists", async () => {
    const redis = createRedisMock();
    const watermarkMs = Date.now() - 45 * 60 * 1000; // 45m ago (> 30m lag + 5m advance threshold)
    const baseline = {
      watermarkMs,
      users: { "1": { resetMs: "", cost: "100.25" } },
      keys: { "10": { resetMs: "", keyHash: hashKey("sk-10"), cost: "40.5" } },
    };
    redis.mget.mockResolvedValueOnce([null, JSON.stringify(baseline), "3"]);
    redis.get.mockResolvedValueOnce("3"); // gen unchanged
    redis.setex.mockResolvedValue("OK");
    vi.mocked(getRedisClient).mockReturnValue(
      redis as unknown as ReturnType<typeof getRedisClient>
    );
    vi.mocked(sumUserAndKeyTotalCostWindowBatch).mockResolvedValueOnce({
      settledUserCosts: new Map([[1, 10]]),
      liveUserCosts: new Map([[1, 2.5]]),
      settledKeyCosts: new Map([[10, 5]]),
      liveKeyCosts: new Map([[10, 1.25]]),
    });

    const result = await getUsersAndKeysTotalCostWithCache(
      [{ userId: 1, resetAt: null }],
      [{ keyId: 10, key: "sk-10", resetAt: null }]
    );

    // Delta query runs with fromInclusive = watermarkMs and no full-table lock needed
    expect(redis.set).not.toHaveBeenCalled();
    expect(sumUserAndKeyTotalCostWindowBatch).toHaveBeenCalledTimes(1);
    const deltaOpts = vi.mocked(sumUserAndKeyTotalCostWindowBatch).mock.calls[0][2];
    expect(deltaOpts.fromInclusive?.getTime()).toBe(watermarkMs);
    expect(result.userCosts.get(1)).toBe(112.75);
    expect(result.keyCosts.get(10)).toBe(46.75);

    // Baseline persisted with advanced watermark and settled total (100.25 + 10 = 110.25)
    const baselineWrite = redis.setex.mock.calls.find(([k]) => k === QUOTA_TOTAL_COST_BASELINE_KEY);
    expect(baselineWrite).toBeDefined();
    const saved = JSON.parse(baselineWrite![2] as string);
    expect(saved.watermarkMs).toBeGreaterThan(watermarkMs);
    expect(saved.users["1"].cost).toBe("110.25");
    expect(saved.keys["10"].cost).toBe("45.5");
  });

  it("backfills only newly added/reset entities without full-table rebuild", async () => {
    const redis = createRedisMock();
    const watermarkMs = Date.now() - 32 * 60 * 1000;
    const baseline = {
      watermarkMs,
      users: { "1": { resetMs: "", cost: "200" } },
      keys: { "10": { resetMs: "", keyHash: hashKey("sk-10"), cost: "200" } },
    };
    redis.mget.mockResolvedValueOnce([null, JSON.stringify(baseline), null]);
    redis.get.mockResolvedValueOnce(null);
    redis.setex.mockResolvedValue("OK");
    vi.mocked(getRedisClient).mockReturnValue(
      redis as unknown as ReturnType<typeof getRedisClient>
    );
    vi.mocked(sumUserCostInTimeRangesBatch).mockResolvedValueOnce(new Map([[2, 15]]));
    vi.mocked(sumKeyCostInTimeRangesBatch).mockResolvedValueOnce(new Map([[20, 15]]));
    vi.mocked(sumUserAndKeyTotalCostWindowBatch).mockResolvedValueOnce({
      settledUserCosts: new Map([
        [1, 0],
        [2, 0],
      ]),
      liveUserCosts: new Map([
        [1, 5],
        [2, 3],
      ]),
      settledKeyCosts: new Map([
        [10, 0],
        [20, 0],
      ]),
      liveKeyCosts: new Map([
        [10, 5],
        [20, 3],
      ]),
    });

    const result = await getUsersAndKeysTotalCostWithCache(
      [
        { userId: 1, resetAt: null },
        { userId: 2, resetAt: null }, // newly added user
      ],
      [
        { keyId: 10, key: "sk-10", resetAt: null },
        { keyId: 20, key: "sk-20", resetAt: null }, // newly added key
      ]
    );

    // Only missing entity (user 2, key 20) backfilled; no full rebuild lock acquired
    expect(redis.set).not.toHaveBeenCalled();
    expect(sumUserCostInTimeRangesBatch).toHaveBeenCalledTimes(1);
    expect(sumKeyCostInTimeRangesBatch).toHaveBeenCalledTimes(1);
    expect(result.userCosts.get(1)).toBe(205);
    expect(result.userCosts.get(2)).toBe(18);
    expect(result.keyCosts.get(20)).toBe(18);
  });

  it("deduplicates concurrent in-process calls via singleflight even when Redis is unavailable", async () => {
    vi.mocked(getRedisClient).mockReturnValue(null);

    let resolveQuery!: (value: {
      userCosts: Map<number, number>;
      keyCosts: Map<number, number>;
    }) => void;
    vi.mocked(sumUserAndKeyTotalCostBatch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveQuery = resolve;
        })
    );

    const p1 = getUsersAndKeysTotalCostWithCache(
      [{ userId: 7, resetAt: null }],
      [{ keyId: 70, key: "sk-70", resetAt: null }]
    );
    const p2 = getUsersAndKeysTotalCostWithCache(
      [{ userId: 7, resetAt: null }],
      [{ keyId: 70, key: "sk-70", resetAt: null }]
    );

    resolveQuery({
      userCosts: new Map([[7, 15]]),
      keyCosts: new Map([[70, 15]]),
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(sumUserAndKeyTotalCostBatch).toHaveBeenCalledTimes(1);
    expect(r1.userCosts.get(7)).toBe(15);
    expect(r2.userCosts.get(7)).toBe(15);
  });

  it("propagates DB errors without double-querying and still releases lock", async () => {
    const redis = createRedisMock();
    redis.mget.mockResolvedValueOnce([null, null, null]);
    redis.set.mockResolvedValueOnce("OK");
    redis.eval.mockResolvedValueOnce(1);
    vi.mocked(getRedisClient).mockReturnValue(
      redis as unknown as ReturnType<typeof getRedisClient>
    );
    vi.mocked(sumUserAndKeyTotalCostWindowBatch).mockRejectedValueOnce(new Error("pg timeout"));

    await expect(
      getUsersAndKeysTotalCostWithCache(
        [{ userId: 9, resetAt: null }],
        [{ keyId: 90, key: "sk-90", resetAt: null }]
      )
    ).rejects.toThrow("pg timeout");

    expect(sumUserAndKeyTotalCostWindowBatch).toHaveBeenCalledTimes(1);
    expect(sumUserAndKeyTotalCostBatch).not.toHaveBeenCalled();
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it("invalidates full cache in O(1) and scoped cache without nuking other entities", async () => {
    const redis = createRedisMock();
    redis.del.mockResolvedValue(1);
    redis.incr.mockResolvedValue(2);
    vi.mocked(getRedisClient).mockReturnValue(
      redis as unknown as ReturnType<typeof getRedisClient>
    );

    await invalidateQuotaTotalCostCache();
    expect(redis.del).toHaveBeenCalledWith(QUOTA_TOTAL_COST_HOT_KEY, QUOTA_TOTAL_COST_BASELINE_KEY);
    expect(redis.incr).toHaveBeenCalledWith(QUOTA_TOTAL_COST_GEN_KEY);

    // Scoped invalidation prunes only affected user/key while keeping others intact
    vi.clearAllMocks();
    redis.del.mockResolvedValue(1);
    redis.setex.mockResolvedValue("OK");
    redis.get.mockResolvedValueOnce(
      JSON.stringify({
        watermarkMs: Date.now() - 35 * 60 * 1000,
        users: {
          "1": { resetMs: "", cost: "100" },
          "2": { resetMs: "", cost: "50" },
        },
        keys: {
          "10": { resetMs: "", keyHash: hashKey("sk-10"), cost: "100" },
          "20": { resetMs: "", keyHash: hashKey("sk-20"), cost: "50" },
        },
      })
    );
    vi.mocked(getRedisClient).mockReturnValue(
      redis as unknown as ReturnType<typeof getRedisClient>
    );

    await invalidateQuotaTotalCostCache({ userIds: [1], keyIds: [10] });
    expect(redis.del).toHaveBeenCalledWith(QUOTA_TOTAL_COST_HOT_KEY);
    expect(redis.setex).toHaveBeenCalledTimes(1);
    const updated = JSON.parse(redis.setex.mock.calls[0][2] as string);
    expect(updated.users["1"]).toBeUndefined();
    expect(updated.users["2"]).toEqual({ resetMs: "", cost: "50" });
    expect(updated.keys["10"]).toBeUndefined();
    expect(updated.keys["20"]).toBeDefined();
  });
});
