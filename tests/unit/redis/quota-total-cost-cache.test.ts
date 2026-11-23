import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRedisClient } from "@/lib/redis/client";
import {
  buildQuotaTotalCostCacheKey,
  getUsersAndKeysTotalCostWithCache,
  invalidateQuotaTotalCostCache,
  QUOTA_TOTAL_COST_CACHE_PREFIX,
} from "@/lib/redis/quota-total-cost-cache";
import { scanPattern } from "@/lib/redis/scan-helper";
import { sumUserAndKeyTotalCostBatch } from "@/repository/statistics";

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

vi.mock("@/lib/redis/scan-helper", () => ({
  scanPattern: vi.fn(),
}));

vi.mock("@/repository/statistics", () => ({
  sumUserAndKeyTotalCostBatch: vi.fn(),
}));

function createRedisMock() {
  return {
    status: "ready",
    get: vi.fn(),
    mget: vi.fn(),
    set: vi.fn(),
    setex: vi.fn(),
    del: vi.fn(),
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

  it("returns cached maps on Redis hit without querying DB", async () => {
    const redis = createRedisMock();
    redis.get.mockResolvedValueOnce(
      JSON.stringify({
        userCosts: [[1, 42.5]],
        keyCosts: [[10, 12.25]],
      })
    );
    vi.mocked(getRedisClient).mockReturnValue(
      redis as unknown as ReturnType<typeof getRedisClient>
    );

    const result = await getUsersAndKeysTotalCostWithCache(
      [{ userId: 1, resetAt: null }],
      [{ keyId: 10, key: "sk-10", resetAt: null }]
    );

    expect(result.userCosts.get(1)).toBe(42.5);
    expect(result.keyCosts.get(10)).toBe(12.25);
    expect(sumUserAndKeyTotalCostBatch).not.toHaveBeenCalled();
  });

  it("computes once via single-pass DB query on cache miss, writes Redis, and releases lock with owner token", async () => {
    const redis = createRedisMock();
    redis.get.mockResolvedValueOnce(null);
    redis.set.mockResolvedValueOnce("OK");
    redis.setex.mockResolvedValueOnce("OK");
    redis.eval.mockResolvedValueOnce(1);
    vi.mocked(getRedisClient).mockReturnValue(
      redis as unknown as ReturnType<typeof getRedisClient>
    );
    vi.mocked(sumUserAndKeyTotalCostBatch).mockResolvedValueOnce({
      userCosts: new Map([[1, 99.9]]),
      keyCosts: new Map([[10, 50.1]]),
    });

    const result = await getUsersAndKeysTotalCostWithCache(
      [{ userId: 1, resetAt: null }],
      [{ keyId: 10, key: "sk-10", resetAt: null }]
    );

    expect(sumUserAndKeyTotalCostBatch).toHaveBeenCalledTimes(1);
    expect(redis.setex).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledTimes(1);
    const [lockKey, lockToken] = redis.set.mock.calls[0] as [string, string];
    expect(lockKey.endsWith(":lock")).toBe(true);
    expect(lockToken.length).toBeGreaterThan(0);
    expect(redis.eval).toHaveBeenCalledWith(expect.any(String), 1, lockKey, lockToken);
    expect(redis.del).not.toHaveBeenCalled();
    expect(result.userCosts.get(1)).toBe(99.9);
    expect(result.keyCosts.get(10)).toBe(50.1);
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
    redis.get.mockResolvedValueOnce(null);
    redis.set.mockResolvedValueOnce("OK");
    redis.eval.mockResolvedValueOnce(1);
    vi.mocked(getRedisClient).mockReturnValue(
      redis as unknown as ReturnType<typeof getRedisClient>
    );
    vi.mocked(sumUserAndKeyTotalCostBatch).mockRejectedValueOnce(new Error("pg timeout"));

    await expect(
      getUsersAndKeysTotalCostWithCache(
        [{ userId: 9, resetAt: null }],
        [{ keyId: 90, key: "sk-90", resetAt: null }]
      )
    ).rejects.toThrow("pg timeout");

    expect(sumUserAndKeyTotalCostBatch).toHaveBeenCalledTimes(1);
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it("stops waiting early and queries DB once when lock disappears without cache fill", async () => {
    const redis = createRedisMock();
    redis.get.mockResolvedValueOnce(null);
    redis.set.mockResolvedValueOnce(null); // lock held by another worker
    redis.mget.mockResolvedValueOnce([null, null]); // lock gone, cache empty
    vi.mocked(getRedisClient).mockReturnValue(
      redis as unknown as ReturnType<typeof getRedisClient>
    );
    vi.mocked(sumUserAndKeyTotalCostBatch).mockResolvedValueOnce({
      userCosts: new Map([[11, 33]]),
      keyCosts: new Map([[110, 33]]),
    });

    const result = await getUsersAndKeysTotalCostWithCache(
      [{ userId: 11, resetAt: null }],
      [{ keyId: 110, key: "sk-110", resetAt: null }]
    );

    expect(redis.mget).toHaveBeenCalledTimes(1);
    expect(sumUserAndKeyTotalCostBatch).toHaveBeenCalledTimes(1);
    expect(result.userCosts.get(11)).toBe(33);
  });

  it("invalidates cached snapshots while skipping lock keys", async () => {
    const redis = createRedisMock();
    redis.del.mockResolvedValueOnce(1);
    vi.mocked(getRedisClient).mockReturnValue(
      redis as unknown as ReturnType<typeof getRedisClient>
    );
    vi.mocked(scanPattern).mockResolvedValueOnce([
      `${QUOTA_TOTAL_COST_CACHE_PREFIX}abc`,
      `${QUOTA_TOTAL_COST_CACHE_PREFIX}abc:lock`,
    ]);

    await invalidateQuotaTotalCostCache();

    expect(redis.del).toHaveBeenCalledWith(`${QUOTA_TOTAL_COST_CACHE_PREFIX}abc`);
  });
});
