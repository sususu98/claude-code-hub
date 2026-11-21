import "server-only";

import { logger } from "@/lib/logger";
import { clipStartByResetAt, resolveKeyCostResetAt } from "@/lib/rate-limit/cost-reset-utils";
import {
  type DailyResetMode,
  getResetInfoWithMode,
  getTimeRangeForPeriodWithMode,
  type ResetInfo,
  type TimeRange,
} from "@/lib/rate-limit/time-utils";
import { getUsersAndKeysTotalCostWithCache } from "@/lib/redis/quota-total-cost-cache";
import { findKeyListBatch } from "@/repository/key";
import {
  type KeyTimeRangeCostEntry,
  type KeyTotalCostTarget,
  sumKeyCostInTimeRangesBatch,
  sumUserCostInTimeRangesBatch,
  type UserTimeRangeCostEntry,
  type UserTotalCostTarget,
} from "@/repository/statistics";
import { findUserListBatch } from "@/repository/user";
import type { Key } from "@/types/key";
import type { User } from "@/types/user";
import type { UserKeyWithUsage, UserQuotaWithUsage } from "../_components/types";

const MAX_USERS_FOR_QUOTAS = 2000;
const USERS_BATCH_SIZE = 200;

interface DailyWindowMeta {
  range: TimeRange;
  resetInfo: ResetInfo;
}

async function resolveDailyWindows(
  configs: ReadonlyArray<{ resetTime: string; resetMode: DailyResetMode }>
): Promise<Map<string, DailyWindowMeta>> {
  const uniquePairs = new Map<string, { resetTime: string; resetMode: DailyResetMode }>();
  for (const cfg of configs) {
    const key = `${cfg.resetMode}|${cfg.resetTime}`;
    if (!uniquePairs.has(key)) {
      uniquePairs.set(key, cfg);
    }
  }

  const entries = await Promise.all(
    [...uniquePairs.entries()].map(async ([mapKey, { resetTime, resetMode }]) => {
      const [range, resetInfo] = await Promise.all([
        getTimeRangeForPeriodWithMode("daily", resetTime, resetMode),
        getResetInfoWithMode("daily", resetTime, resetMode),
      ]);
      return [mapKey, { range, resetInfo }] as const;
    })
  );

  return new Map(entries);
}

/**
 * Load all active users with their quota usage and key usage in minimal batch queries:
 * 1. Paginated users + keys metadata (no unused key statistics / LATERAL last-usage queries)
 * 2. Single LATERAL batch query for all users' daily cost (replaces N+1 getUserLimitUsage)
 * 3. Single LATERAL batch query for all keys' today cost (respecting timezone, reset mode, and costResetAt)
 * 4. Cached / single-pass SQL query for both user and key all-time total costs
 */
export async function loadUsersWithQuotas(): Promise<UserQuotaWithUsage[]> {
  const collectedUsers: User[] = [];
  const maxIterations = Math.ceil(MAX_USERS_FOR_QUOTAS / USERS_BATCH_SIZE) + 1;
  let cursor: string | undefined;
  let iterations = 0;

  while (collectedUsers.length < MAX_USERS_FOR_QUOTAS && iterations < maxIterations) {
    iterations += 1;
    const { users, nextCursor, hasMore } = await findUserListBatch({
      cursor,
      limit: USERS_BATCH_SIZE,
    });

    collectedUsers.push(...users);
    if (!hasMore || !nextCursor) {
      break;
    }

    cursor = nextCursor;
  }

  if (iterations >= maxIterations) {
    logger.warn("loadUsersWithQuotas: reached max iterations, results may be incomplete");
  }

  if (collectedUsers.length === 0) {
    return [];
  }

  const allUserIds = collectedUsers.map((u) => u.id);
  const keysMap = await findKeyListBatch(allUserIds);

  // Deduplicate daily time-window calculations across all users and keys.
  const windowConfigs: Array<{ resetTime: string; resetMode: DailyResetMode }> = [];
  for (const user of collectedUsers) {
    windowConfigs.push({
      resetTime: user.dailyResetTime ?? "00:00",
      resetMode: user.dailyResetMode ?? "fixed",
    });
    const userKeys = keysMap.get(user.id) ?? [];
    for (const key of userKeys) {
      windowConfigs.push({
        resetTime: key.dailyResetTime ?? "00:00",
        resetMode: key.dailyResetMode ?? "fixed",
      });
    }
  }
  const dailyWindows = await resolveDailyWindows(windowConfigs);

  const userDailyEntries: UserTimeRangeCostEntry[] = [];
  const keyDailyEntries: KeyTimeRangeCostEntry[] = [];
  const userTotalTargets: UserTotalCostTarget[] = [];
  const keyTotalTargets: KeyTotalCostTarget[] = [];
  const userResetAtByUserId = new Map<number, Date | undefined>();

  for (const user of collectedUsers) {
    const userResetAt = user.costResetAt instanceof Date ? user.costResetAt : null;
    const userWindowKey = `${user.dailyResetMode ?? "fixed"}|${user.dailyResetTime ?? "00:00"}`;
    const userWindow = dailyWindows.get(userWindowKey)!;

    userResetAtByUserId.set(user.id, userWindow.resetInfo.resetAt);
    userDailyEntries.push({
      userId: user.id,
      startTime: clipStartByResetAt(userWindow.range.startTime, userResetAt),
      endTime: userWindow.range.endTime,
    });
    userTotalTargets.push({
      userId: user.id,
      resetAt: userResetAt,
    });

    const userKeys: Key[] = keysMap.get(user.id) ?? [];
    for (const key of userKeys) {
      const keyResetAt = key.costResetAt instanceof Date ? key.costResetAt : null;
      const resolvedKeyResetAt = resolveKeyCostResetAt(keyResetAt, userResetAt);
      const keyWindowKey = `${key.dailyResetMode ?? "fixed"}|${key.dailyResetTime ?? "00:00"}`;
      const keyWindow = dailyWindows.get(keyWindowKey)!;

      keyDailyEntries.push({
        keyId: key.id,
        key: key.key,
        startTime: clipStartByResetAt(keyWindow.range.startTime, resolvedKeyResetAt),
        endTime: keyWindow.range.endTime,
      });
      keyTotalTargets.push({
        keyId: key.id,
        key: key.key,
        resetAt: resolvedKeyResetAt,
      });
    }
  }

  const [userDailyCostMap, keyTodayCostMap, totalCosts] = await Promise.all([
    sumUserCostInTimeRangesBatch(userDailyEntries),
    sumKeyCostInTimeRangesBatch(keyDailyEntries),
    getUsersAndKeysTotalCostWithCache(userTotalTargets, keyTotalTargets, Infinity),
  ]);

  return collectedUsers.map((user) => {
    const userKeys = keysMap.get(user.id) ?? [];

    const keysWithUsage: UserKeyWithUsage[] = userKeys.map((key) => ({
      id: key.id,
      name: key.name,
      status: key.isEnabled ? "enabled" : "disabled",
      todayUsage: keyTodayCostMap.get(key.id) ?? 0,
      totalUsage: totalCosts.keyCosts.get(key.id) ?? 0,
      limit5hUsd: key.limit5hUsd ?? null,
      limitDailyUsd: key.limitDailyUsd ?? null,
      limitWeeklyUsd: key.limitWeeklyUsd ?? null,
      limitMonthlyUsd: key.limitMonthlyUsd ?? null,
      limitTotalUsd: key.limitTotalUsd ?? null,
      limitConcurrentSessions: key.limitConcurrentSessions || 0,
      dailyResetMode: key.dailyResetMode,
      dailyResetTime: key.dailyResetTime,
    }));

    return {
      id: user.id,
      name: user.name,
      note: user.description || undefined,
      role: user.role,
      isEnabled: user.isEnabled,
      expiresAt: user.expiresAt ?? null,
      providerGroup: user.providerGroup || undefined,
      tags: user.tags || [],
      quota: {
        rpm: {
          current: 0,
          limit: user.rpm,
          window: "per_minute",
        },
        dailyCost: {
          current: userDailyCostMap.get(user.id) ?? 0,
          limit: user.dailyQuota,
          resetAt: userResetAtByUserId.get(user.id),
        },
      },
      limit5hUsd: user.limit5hUsd ?? null,
      limitWeeklyUsd: user.limitWeeklyUsd ?? null,
      limitMonthlyUsd: user.limitMonthlyUsd ?? null,
      limitTotalUsd: user.limitTotalUsd ?? null,
      limitConcurrentSessions: user.limitConcurrentSessions ?? null,
      totalUsage: totalCosts.userCosts.get(user.id) ?? 0,
      keys: keysWithUsage,
    };
  });
}
