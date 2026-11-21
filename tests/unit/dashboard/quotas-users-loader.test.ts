import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadUsersWithQuotas } from "@/app/[locale]/dashboard/quotas/users/_lib/load-users-quotas";
import { getResetInfoWithMode, getTimeRangeForPeriodWithMode } from "@/lib/rate-limit/time-utils";
import { getUsersAndKeysTotalCostWithCache } from "@/lib/redis/quota-total-cost-cache";
import { findKeyListBatch } from "@/repository/key";
import { sumKeyCostInTimeRangesBatch, sumUserCostInTimeRangesBatch } from "@/repository/statistics";
import { findUserListBatch } from "@/repository/user";
import type { Key } from "@/types/key";
import type { User } from "@/types/user";

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/repository/user", () => ({
  findUserListBatch: vi.fn(),
}));

vi.mock("@/repository/key", () => ({
  findKeyListBatch: vi.fn(),
}));

vi.mock("@/repository/statistics", () => ({
  sumUserCostInTimeRangesBatch: vi.fn(),
  sumKeyCostInTimeRangesBatch: vi.fn(),
}));

vi.mock("@/lib/redis/quota-total-cost-cache", () => ({
  getUsersAndKeysTotalCostWithCache: vi.fn(),
}));

vi.mock("@/lib/rate-limit/time-utils", () => ({
  getTimeRangeForPeriodWithMode: vi.fn(),
  getResetInfoWithMode: vi.fn(),
}));

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    name: "alice",
    description: "note",
    role: "user",
    rpm: 60,
    dailyQuota: 100,
    providerGroup: "default",
    tags: ["vip"],
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    limit5hUsd: 20,
    limit5hResetMode: "rolling",
    limitWeeklyUsd: 300,
    limitMonthlyUsd: 1000,
    limitTotalUsd: 5000,
    costResetAt: null,
    limitConcurrentSessions: 5,
    dailyResetMode: "fixed",
    dailyResetTime: "00:00",
    isEnabled: true,
    expiresAt: null,
    ...overrides,
  };
}

function makeKey(overrides: Partial<Key> = {}): Key {
  return {
    id: 10,
    userId: 1,
    key: "sk-key-10",
    name: "primary",
    isEnabled: true,
    canLoginWebUi: true,
    limit5hUsd: null,
    limit5hResetMode: "rolling",
    limitDailyUsd: 50,
    dailyResetMode: "fixed",
    dailyResetTime: "00:00",
    limitWeeklyUsd: null,
    limitMonthlyUsd: null,
    limitTotalUsd: 500,
    costResetAt: null,
    limitConcurrentSessions: 2,
    providerGroup: null,
    cacheTtlPreference: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("loadUsersWithQuotas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads users and keys via batch queries without N+1 calls and clips ranges by costResetAt", async () => {
    const userResetAt = new Date("2026-11-21T06:00:00Z");
    const keyResetAt = new Date("2026-11-21T08:00:00Z");
    const dayStart = new Date("2026-11-21T00:00:00Z");
    const now = new Date("2026-11-21T12:00:00Z");
    const nextReset = new Date("2026-11-22T00:00:00Z");

    const user1 = makeUser({ id: 1, name: "alice", costResetAt: userResetAt });
    const user2 = makeUser({ id: 2, name: "bob", costResetAt: null });

    const key1 = makeKey({ id: 10, userId: 1, key: "sk-10", costResetAt: keyResetAt });
    const key2 = makeKey({ id: 11, userId: 1, key: "sk-11", costResetAt: null });
    const key3 = makeKey({ id: 20, userId: 2, key: "sk-20", isEnabled: false });

    vi.mocked(findUserListBatch).mockResolvedValueOnce({
      users: [user1, user2],
      nextCursor: null,
      hasMore: false,
    });
    vi.mocked(findKeyListBatch).mockResolvedValueOnce(
      new Map([
        [1, [key1, key2]],
        [2, [key3]],
      ])
    );
    vi.mocked(getTimeRangeForPeriodWithMode).mockResolvedValue({
      startTime: dayStart,
      endTime: now,
    });
    vi.mocked(getResetInfoWithMode).mockResolvedValue({
      type: "custom",
      resetAt: nextReset,
    });
    vi.mocked(sumUserCostInTimeRangesBatch).mockResolvedValueOnce(
      new Map([
        [1, 14.5],
        [2, 3.2],
      ])
    );
    vi.mocked(sumKeyCostInTimeRangesBatch).mockResolvedValueOnce(
      new Map([
        [10, 4.5],
        [11, 10.0],
        [20, 3.2],
      ])
    );
    vi.mocked(getUsersAndKeysTotalCostWithCache).mockResolvedValueOnce({
      userCosts: new Map([
        [1, 120.5],
        [2, 55.0],
      ]),
      keyCosts: new Map([
        [10, 40.5],
        [11, 80.0],
        [20, 55.0],
      ]),
    });

    const result = await loadUsersWithQuotas();

    // All users and keys share ("00:00", "fixed"), so time range/reset info resolved only once
    expect(getTimeRangeForPeriodWithMode).toHaveBeenCalledTimes(1);
    expect(getResetInfoWithMode).toHaveBeenCalledTimes(1);
    expect(sumUserCostInTimeRangesBatch).toHaveBeenCalledTimes(1);
    expect(sumKeyCostInTimeRangesBatch).toHaveBeenCalledTimes(1);
    expect(getUsersAndKeysTotalCostWithCache).toHaveBeenCalledTimes(1);

    // Verify resetAt clipping passed into batch queries
    expect(sumUserCostInTimeRangesBatch).toHaveBeenCalledWith([
      { userId: 1, startTime: userResetAt, endTime: now },
      { userId: 2, startTime: dayStart, endTime: now },
    ]);
    expect(sumKeyCostInTimeRangesBatch).toHaveBeenCalledWith([
      { keyId: 10, key: "sk-10", startTime: keyResetAt, endTime: now },
      { keyId: 11, key: "sk-11", startTime: userResetAt, endTime: now },
      { keyId: 20, key: "sk-20", startTime: dayStart, endTime: now },
    ]);
    expect(getUsersAndKeysTotalCostWithCache).toHaveBeenCalledWith(
      [
        { userId: 1, resetAt: userResetAt },
        { userId: 2, resetAt: null },
      ],
      [
        { keyId: 10, key: "sk-10", resetAt: keyResetAt },
        { keyId: 11, key: "sk-11", resetAt: userResetAt },
        { keyId: 20, key: "sk-20", resetAt: null },
      ],
      Infinity
    );

    expect(result).toHaveLength(2);
    expect(result[0].quota).toEqual({
      rpm: { current: 0, limit: 60, window: "per_minute" },
      dailyCost: { current: 14.5, limit: 100, resetAt: nextReset },
    });
    expect(result[0].totalUsage).toBe(120.5);
    expect(result[0].keys[0]).toMatchObject({
      id: 10,
      status: "enabled",
      todayUsage: 4.5,
      totalUsage: 40.5,
    });
    expect(result[1].keys[0]).toMatchObject({
      id: 20,
      status: "disabled",
      todayUsage: 3.2,
      totalUsage: 55.0,
    });
  });

  it("returns empty array immediately when there are no active users", async () => {
    vi.mocked(findUserListBatch).mockResolvedValueOnce({
      users: [],
      nextCursor: null,
      hasMore: false,
    });

    const result = await loadUsersWithQuotas();
    expect(result).toEqual([]);
    expect(findKeyListBatch).not.toHaveBeenCalled();
    expect(sumUserCostInTimeRangesBatch).not.toHaveBeenCalled();
  });
});
