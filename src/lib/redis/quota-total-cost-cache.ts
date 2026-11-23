import { createHash, randomUUID } from "node:crypto";
import { logger } from "@/lib/logger";
import { Decimal } from "@/lib/utils/currency";
import {
  type KeyTotalCostTarget,
  sumKeyCostInTimeRangesBatch,
  sumUserAndKeyTotalCostBatch,
  sumUserAndKeyTotalCostWindowBatch,
  sumUserCostInTimeRangesBatch,
  type UserAndKeyTotalCostResult,
  type UserTotalCostTarget,
} from "@/repository/statistics";
import { getRedisClient } from "./client";

export const QUOTA_TOTAL_COST_CACHE_PREFIX = "quota:users:total_cost:v2:";
export const QUOTA_TOTAL_COST_BASELINE_KEY = `${QUOTA_TOTAL_COST_CACHE_PREFIX}baseline:inf`;
export const QUOTA_TOTAL_COST_HOT_KEY = `${QUOTA_TOTAL_COST_CACHE_PREFIX}hot:inf`;
export const QUOTA_TOTAL_COST_LOCK_KEY = `${QUOTA_TOTAL_COST_CACHE_PREFIX}lock:inf`;
export const QUOTA_TOTAL_COST_GEN_KEY = `${QUOTA_TOTAL_COST_CACHE_PREFIX}gen`;

// 15s hot cache avoids redundant DB work on rapid consecutive refreshes.
const HOT_CACHE_TTL_SECONDS = 15;
// 7-day persistent baseline; refreshed on every watermark advance.
const BASELINE_TTL_SECONDS = 7 * 24 * 60 * 60;
// 30-minute safety lag behind NOW() ensures in-flight long streaming requests
// (up to 10m proxy timeout) are finalized before entering the immutable baseline.
const WATERMARK_LAG_MS = 30 * 60 * 1000;
// Advance & persist baseline when watermark moves forward by at least 5 minutes.
const BASELINE_ADVANCE_INTERVAL_MS = 5 * 60 * 1000;
// If idle for >48h, rebuild baseline cleanly instead of running a multi-day index scan.
const MAX_DELTA_SPAN_MS = 48 * 60 * 60 * 1000;
// Backfill up to 20 newly added or reset entities individually via index-only scans
// without throwing away the existing baseline for all other entities.
const MAX_INDIVIDUAL_BACKFILL_ENTITIES = 20;
// Stay well below PostgreSQL's 65,535 bind parameter limit for window queries.
const WINDOW_QUERY_MAX_PARAMS = 50000;

const LOCK_TTL_SECONDS = 60;
const RETRY_INTERVAL_MS = 200;
const MAX_LOCK_WAIT_RETRIES = 125; // up to 25s waiting for another worker's full baseline build

const RELEASE_LOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

interface SerializedHotCachePayload {
  digest: string;
  userCosts: Array<[number, number]>;
  keyCosts: Array<[number, number]>;
}

interface BaselineUserEntry {
  resetMs: string;
  cost: string;
}

interface BaselineKeyEntry {
  resetMs: string;
  keyHash: string;
  cost: string;
}

interface BaselineSnapshot {
  watermarkMs: number;
  users: Record<string, BaselineUserEntry>;
  keys: Record<string, BaselineKeyEntry>;
}

const inFlightRequests = new Map<string, Promise<UserAndKeyTotalCostResult>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeResetMs(resetAt: Date | null | undefined): string {
  return resetAt instanceof Date && !Number.isNaN(resetAt.getTime())
    ? String(resetAt.getTime())
    : "";
}

function hashKeySecret(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/**
 * Build a deterministic, secret-free digest key from entity IDs and resetAt
 * timestamps. Any user/key addition, removal, or costResetAt change produces
 * a new digest immediately.
 */
export function buildQuotaTotalCostCacheKey(
  users: readonly UserTotalCostTarget[],
  keys: readonly KeyTotalCostTarget[],
  maxAgeDays: number = Infinity
): string {
  const userPart = [...users]
    .sort((a, b) => a.userId - b.userId)
    .map((u) => `${u.userId}:${normalizeResetMs(u.resetAt)}`)
    .join(",");

  const keyPart = [...keys]
    .sort((a, b) => a.keyId - b.keyId)
    .map((k) => `${k.keyId}:${normalizeResetMs(k.resetAt)}`)
    .join(",");

  const agePart = Number.isFinite(maxAgeDays) ? String(Math.floor(maxAgeDays)) : "inf";
  const digest = createHash("sha256")
    .update(`u=${userPart}|k=${keyPart}|age=${agePart}`)
    .digest("hex")
    .slice(0, 32);

  return `${QUOTA_TOTAL_COST_CACHE_PREFIX}${digest}`;
}

function serializeHotResult(digest: string, result: UserAndKeyTotalCostResult): string {
  const payload: SerializedHotCachePayload = {
    digest,
    userCosts: Array.from(result.userCosts.entries()),
    keyCosts: Array.from(result.keyCosts.entries()),
  };
  return JSON.stringify(payload);
}

function deserializeHotResult(
  raw: string,
  expectedDigest: string
): UserAndKeyTotalCostResult | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SerializedHotCachePayload>;
    if (
      parsed.digest !== expectedDigest ||
      !Array.isArray(parsed.userCosts) ||
      !Array.isArray(parsed.keyCosts)
    ) {
      return null;
    }
    return {
      userCosts: new Map(
        parsed.userCosts.map(([id, cost]) => [Number(id), Number(cost) || 0] as const)
      ),
      keyCosts: new Map(
        parsed.keyCosts.map(([id, cost]) => [Number(id), Number(cost) || 0] as const)
      ),
    };
  } catch {
    return null;
  }
}

function deserializeBaseline(raw: string): BaselineSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as Partial<BaselineSnapshot>;
    if (
      typeof parsed.watermarkMs !== "number" ||
      !Number.isFinite(parsed.watermarkMs) ||
      !parsed.users ||
      typeof parsed.users !== "object" ||
      !parsed.keys ||
      typeof parsed.keys !== "object"
    ) {
      return null;
    }
    return {
      watermarkMs: parsed.watermarkMs,
      users: parsed.users,
      keys: parsed.keys,
    };
  } catch {
    return null;
  }
}

function addDec(a: string | number | undefined, b: number | undefined): Decimal {
  return new Decimal(a ?? 0).plus(new Decimal(b ?? 0));
}

async function computeIncrementalFromBaseline(
  redis: NonNullable<ReturnType<typeof getRedisClient>>,
  baseline: BaselineSnapshot,
  startGen: string | null,
  digest: string,
  users: readonly UserTotalCostTarget[],
  keys: readonly KeyTotalCostTarget[],
  nowMs: number
): Promise<UserAndKeyTotalCostResult | null> {
  if (baseline.watermarkMs > nowMs || nowMs - baseline.watermarkMs > MAX_DELTA_SPAN_MS) {
    return null;
  }

  const missingUsers: UserTotalCostTarget[] = [];
  for (const u of users) {
    const entry = baseline.users[String(u.userId)];
    if (!entry || entry.resetMs !== normalizeResetMs(u.resetAt)) {
      missingUsers.push(u);
    }
  }

  const missingKeys: Array<KeyTotalCostTarget & { keyHash: string }> = [];
  for (const k of keys) {
    const keyHash = hashKeySecret(k.key);
    const entry = baseline.keys[String(k.keyId)];
    if (!entry || entry.resetMs !== normalizeResetMs(k.resetAt) || entry.keyHash !== keyHash) {
      missingKeys.push({ ...k, keyHash });
    }
  }

  if (missingUsers.length + missingKeys.length > MAX_INDIVIDUAL_BACKFILL_ENTITIES) {
    return null;
  }

  const nextUsers: Record<string, BaselineUserEntry> = { ...baseline.users };
  const nextKeys: Record<string, BaselineKeyEntry> = { ...baseline.keys };
  let baselineDirty = false;

  // Backfill only missing/reset entities up to baseline.watermarkMs using index-only scans.
  if (missingUsers.length > 0 || missingKeys.length > 0) {
    const watermarkDate = new Date(baseline.watermarkMs);
    const epoch = new Date(0);

    const userBackfillEntries = missingUsers
      .map((u) => ({
        userId: u.userId,
        startTime:
          u.resetAt instanceof Date && !Number.isNaN(u.resetAt.getTime()) ? u.resetAt : epoch,
        endTime: watermarkDate,
      }))
      .filter((e) => e.startTime < e.endTime);

    const keyBackfillEntries = missingKeys
      .map((k) => ({
        keyId: k.keyId,
        key: k.key,
        startTime:
          k.resetAt instanceof Date && !Number.isNaN(k.resetAt.getTime()) ? k.resetAt : epoch,
        endTime: watermarkDate,
      }))
      .filter((e) => e.startTime < e.endTime);

    const [backfilledUsers, backfilledKeys] = await Promise.all([
      userBackfillEntries.length > 0
        ? sumUserCostInTimeRangesBatch(userBackfillEntries)
        : Promise.resolve(new Map<number, number>()),
      keyBackfillEntries.length > 0
        ? sumKeyCostInTimeRangesBatch(keyBackfillEntries)
        : Promise.resolve(new Map<number, number>()),
    ]);

    for (const u of missingUsers) {
      nextUsers[String(u.userId)] = {
        resetMs: normalizeResetMs(u.resetAt),
        cost: new Decimal(backfilledUsers.get(u.userId) ?? 0).toString(),
      };
    }
    for (const k of missingKeys) {
      nextKeys[String(k.keyId)] = {
        resetMs: normalizeResetMs(k.resetAt),
        keyHash: k.keyHash,
        cost: new Decimal(backfilledKeys.get(k.keyId) ?? 0).toString(),
      };
    }
    baselineDirty = true;
  }

  // Fast index-scan delta query for [baseline.watermarkMs, +inf), split at targetWatermarkMs.
  const targetWatermarkMs = Math.max(baseline.watermarkMs, nowMs - WATERMARK_LAG_MS);
  const delta = await sumUserAndKeyTotalCostWindowBatch(users, keys, {
    fromInclusive: new Date(baseline.watermarkMs),
    splitAt: new Date(targetWatermarkMs),
  });

  const shouldAdvance =
    baselineDirty || targetWatermarkMs - baseline.watermarkMs >= BASELINE_ADVANCE_INTERVAL_MS;

  const userCosts = new Map<number, number>();
  const keyCosts = new Map<number, number>();

  for (const u of users) {
    const idKey = String(u.userId);
    const baseEntry = nextUsers[idKey];
    const settledTotal = addDec(baseEntry?.cost, delta.settledUserCosts.get(u.userId));
    const finalTotal = settledTotal.plus(new Decimal(delta.liveUserCosts.get(u.userId) ?? 0));
    userCosts.set(u.userId, finalTotal.toNumber());
    if (shouldAdvance) {
      nextUsers[idKey] = {
        resetMs: normalizeResetMs(u.resetAt),
        cost: settledTotal.toString(),
      };
    }
  }

  for (const k of keys) {
    const idKey = String(k.keyId);
    const baseEntry = nextKeys[idKey];
    const settledTotal = addDec(baseEntry?.cost, delta.settledKeyCosts.get(k.keyId));
    const finalTotal = settledTotal.plus(new Decimal(delta.liveKeyCosts.get(k.keyId) ?? 0));
    keyCosts.set(k.keyId, finalTotal.toNumber());
    if (shouldAdvance) {
      nextKeys[idKey] = {
        resetMs: normalizeResetMs(k.resetAt),
        keyHash: hashKeySecret(k.key),
        cost: settledTotal.toString(),
      };
    }
  }

  const result: UserAndKeyTotalCostResult = { userCosts, keyCosts };

  // Persist updated baseline & hot cache only if no full invalidation raced with us.
  try {
    const currentGen = await redis.get(QUOTA_TOTAL_COST_GEN_KEY);
    if (currentGen === startGen) {
      const writes: Array<Promise<unknown>> = [
        redis.setex(
          QUOTA_TOTAL_COST_HOT_KEY,
          HOT_CACHE_TTL_SECONDS,
          serializeHotResult(digest, result)
        ),
      ];
      if (shouldAdvance) {
        const updatedBaseline: BaselineSnapshot = {
          watermarkMs: targetWatermarkMs,
          users: nextUsers,
          keys: nextKeys,
        };
        writes.push(
          redis.setex(
            QUOTA_TOTAL_COST_BASELINE_KEY,
            BASELINE_TTL_SECONDS,
            JSON.stringify(updatedBaseline)
          )
        );
      }
      await Promise.all(writes);
    }
  } catch (writeErr) {
    logger.warn("[QuotaTotalCostCache] Failed to update incremental cache", {
      error: writeErr instanceof Error ? writeErr.message : String(writeErr),
    });
  }

  return result;
}

async function computeAllTimeWithIncrementalCache(
  digest: string,
  users: readonly UserTotalCostTarget[],
  keys: readonly KeyTotalCostTarget[]
): Promise<UserAndKeyTotalCostResult> {
  const estimatedParams = users.length * 2 + keys.length * 3;
  const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
  if (redis?.status !== "ready" || estimatedParams > WINDOW_QUERY_MAX_PARAMS) {
    return await sumUserAndKeyTotalCostBatch(users, keys, Infinity);
  }

  // 1. Read hot cache, baseline snapshot, and invalidation generation in one round-trip.
  let hotRaw: string | null = null;
  let baselineRaw: string | null = null;
  let startGen: string | null = null;
  try {
    if (typeof redis.mget === "function") {
      [hotRaw, baselineRaw, startGen] = await redis.mget(
        QUOTA_TOTAL_COST_HOT_KEY,
        QUOTA_TOTAL_COST_BASELINE_KEY,
        QUOTA_TOTAL_COST_GEN_KEY
      );
    } else {
      hotRaw = await redis.get(QUOTA_TOTAL_COST_HOT_KEY);
      baselineRaw = await redis.get(QUOTA_TOTAL_COST_BASELINE_KEY);
      startGen = await redis.get(QUOTA_TOTAL_COST_GEN_KEY);
    }
  } catch (redisErr) {
    logger.warn("[QuotaTotalCostCache] Redis read error, falling back to direct query", {
      error: redisErr instanceof Error ? redisErr.message : String(redisErr),
    });
    return await sumUserAndKeyTotalCostBatch(users, keys, Infinity);
  }

  if (hotRaw) {
    const hotResult = deserializeHotResult(hotRaw, digest);
    if (hotResult) {
      return hotResult;
    }
  }

  // 2. Fast incremental path: reuse existing 7-day baseline + run millisecond delta query.
  const existingBaseline = baselineRaw ? deserializeBaseline(baselineRaw) : null;
  if (existingBaseline) {
    const incremental = await computeIncrementalFromBaseline(
      redis,
      existingBaseline,
      startGen,
      digest,
      users,
      keys,
      Date.now()
    );
    if (incremental) {
      return incremental;
    }
  }

  // 3. Cold baseline build (only runs once per 7 days / after >48h idle / full flush).
  //    Use a distributed lock so concurrent workers do not trigger parallel full-table scans.
  const lockToken = randomUUID();
  let locked = false;

  try {
    try {
      const lockResult = await redis.set(
        QUOTA_TOTAL_COST_LOCK_KEY,
        lockToken,
        "EX",
        LOCK_TTL_SECONDS,
        "NX"
      );
      locked = lockResult === "OK";
    } catch (lockErr) {
      logger.warn("[QuotaTotalCostCache] Redis lock error, falling back to direct query", {
        error: lockErr instanceof Error ? lockErr.message : String(lockErr),
      });
      return await sumUserAndKeyTotalCostBatch(users, keys, Infinity);
    }

    if (locked) {
      const nowMs = Date.now();
      const watermarkMs = nowMs - WATERMARK_LAG_MS;
      const split = await sumUserAndKeyTotalCostWindowBatch(users, keys, {
        splitAt: new Date(watermarkMs),
      });

      const baselineUsers: Record<string, BaselineUserEntry> = {};
      const baselineKeys: Record<string, BaselineKeyEntry> = {};
      const userCosts = new Map<number, number>();
      const keyCosts = new Map<number, number>();

      for (const u of users) {
        const settled = new Decimal(split.settledUserCosts.get(u.userId) ?? 0);
        const live = new Decimal(split.liveUserCosts.get(u.userId) ?? 0);
        baselineUsers[String(u.userId)] = {
          resetMs: normalizeResetMs(u.resetAt),
          cost: settled.toString(),
        };
        userCosts.set(u.userId, settled.plus(live).toNumber());
      }

      for (const k of keys) {
        const settled = new Decimal(split.settledKeyCosts.get(k.keyId) ?? 0);
        const live = new Decimal(split.liveKeyCosts.get(k.keyId) ?? 0);
        baselineKeys[String(k.keyId)] = {
          resetMs: normalizeResetMs(k.resetAt),
          keyHash: hashKeySecret(k.key),
          cost: settled.toString(),
        };
        keyCosts.set(k.keyId, settled.plus(live).toNumber());
      }

      const result: UserAndKeyTotalCostResult = { userCosts, keyCosts };
      const snapshot: BaselineSnapshot = {
        watermarkMs,
        users: baselineUsers,
        keys: baselineKeys,
      };

      try {
        const currentGen = await redis.get(QUOTA_TOTAL_COST_GEN_KEY);
        if (currentGen === startGen) {
          await Promise.all([
            redis.setex(
              QUOTA_TOTAL_COST_BASELINE_KEY,
              BASELINE_TTL_SECONDS,
              JSON.stringify(snapshot)
            ),
            redis.setex(
              QUOTA_TOTAL_COST_HOT_KEY,
              HOT_CACHE_TTL_SECONDS,
              serializeHotResult(digest, result)
            ),
          ]);
        }
      } catch (writeErr) {
        logger.warn("[QuotaTotalCostCache] Failed to write baseline cache", {
          error: writeErr instanceof Error ? writeErr.message : String(writeErr),
        });
      }

      return result;
    }

    // Another worker is building the baseline; wait until hot/baseline cache appears or lock clears.
    try {
      for (let i = 0; i < MAX_LOCK_WAIT_RETRIES; i++) {
        await sleep(RETRY_INTERVAL_MS);
        const [retriedHot, retriedBase, lockValue] =
          typeof redis.mget === "function"
            ? await redis.mget(
                QUOTA_TOTAL_COST_HOT_KEY,
                QUOTA_TOTAL_COST_BASELINE_KEY,
                QUOTA_TOTAL_COST_LOCK_KEY
              )
            : [
                await redis.get(QUOTA_TOTAL_COST_HOT_KEY),
                await redis.get(QUOTA_TOTAL_COST_BASELINE_KEY),
                "1",
              ];

        if (retriedHot) {
          const parsedHot = deserializeHotResult(retriedHot, digest);
          if (parsedHot) {
            return parsedHot;
          }
        }
        if (retriedBase) {
          const parsedBase = deserializeBaseline(retriedBase);
          if (parsedBase) {
            const genNow = await redis.get(QUOTA_TOTAL_COST_GEN_KEY);
            const incremental = await computeIncrementalFromBaseline(
              redis,
              parsedBase,
              genNow,
              digest,
              users,
              keys,
              Date.now()
            );
            if (incremental) {
              return incremental;
            }
          }
        }
        if (lockValue === null) {
          break;
        }
      }
    } catch (waitErr) {
      logger.warn(
        "[QuotaTotalCostCache] Redis error while waiting for baseline lock, falling back to direct query",
        {
          error: waitErr instanceof Error ? waitErr.message : String(waitErr),
        }
      );
      return await sumUserAndKeyTotalCostBatch(users, keys, Infinity);
    }

    logger.warn(
      "[QuotaTotalCostCache] Lock wait ended without cached baseline, falling back to direct query"
    );
    return await sumUserAndKeyTotalCostBatch(users, keys, Infinity);
  } finally {
    if (locked) {
      const releasePromise =
        typeof redis.eval === "function"
          ? redis.eval(RELEASE_LOCK_LUA, 1, QUOTA_TOTAL_COST_LOCK_KEY, lockToken)
          : redis.del(QUOTA_TOTAL_COST_LOCK_KEY);
      await releasePromise.catch((err) => {
        logger.warn("[QuotaTotalCostCache] Failed to release lock", {
          lockKey: QUOTA_TOTAL_COST_LOCK_KEY,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }
}

/**
 * Fetch user & key total costs with in-process singleflight + incremental
 * watermarked Redis baseline (7-day TTL) + 15s hot cache.
 *
 * After the initial baseline build, every visit (even hours later) runs only
 * a millisecond index-scan delta query over recent usage_ledger rows.
 */
export async function getUsersAndKeysTotalCostWithCache(
  users: readonly UserTotalCostTarget[],
  keys: readonly KeyTotalCostTarget[],
  maxAgeDays: number = Infinity
): Promise<UserAndKeyTotalCostResult> {
  if (users.length === 0 && keys.length === 0) {
    return { userCosts: new Map(), keyCosts: new Map() };
  }

  const cacheKey = buildQuotaTotalCostCacheKey(users, keys, maxAgeDays);
  const existing = inFlightRequests.get(cacheKey);
  if (existing) {
    return existing;
  }

  const promise = (
    Number.isFinite(maxAgeDays)
      ? sumUserAndKeyTotalCostBatch(users, keys, maxAgeDays)
      : computeAllTimeWithIncrementalCache(cacheKey, users, keys)
  ).finally(() => {
    inFlightRequests.delete(cacheKey);
  });

  inFlightRequests.set(cacheKey, promise);
  return promise;
}

/**
 * Invalidate cached user/key total cost snapshots in O(1) without scanning Redis.
 *
 * When `scope` specifies affected userIds/keyIds, only the hot cache is cleared
 * (and those entity entries are pruned from the baseline if present), avoiding a
 * full-table rebuild for unaffected users. Without `scope`, both hot cache and
 * baseline are deleted and the generation counter is incremented.
 */
export async function invalidateQuotaTotalCostCache(scope?: {
  userIds?: readonly number[];
  keyIds?: readonly number[];
}): Promise<void> {
  const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
  if (redis?.status !== "ready") {
    return;
  }

  try {
    const hasScope =
      scope !== undefined && ((scope.userIds?.length ?? 0) > 0 || (scope.keyIds?.length ?? 0) > 0);

    if (!hasScope) {
      const ops: Array<Promise<unknown>> = [];
      if (typeof redis.del === "function") {
        ops.push(redis.del(QUOTA_TOTAL_COST_HOT_KEY, QUOTA_TOTAL_COST_BASELINE_KEY));
      }
      if (typeof redis.incr === "function") {
        ops.push(redis.incr(QUOTA_TOTAL_COST_GEN_KEY));
      }
      await Promise.all(ops);
      return;
    }

    if (typeof redis.del === "function") {
      await redis.del(QUOTA_TOTAL_COST_HOT_KEY);
    }

    if (typeof redis.get === "function" && typeof redis.setex === "function") {
      const raw = await redis.get(QUOTA_TOTAL_COST_BASELINE_KEY);
      const baseline = raw ? deserializeBaseline(raw) : null;
      if (baseline) {
        let changed = false;
        for (const uid of scope.userIds ?? []) {
          const k = String(uid);
          if (k in baseline.users) {
            delete baseline.users[k];
            changed = true;
          }
        }
        for (const kid of scope.keyIds ?? []) {
          const k = String(kid);
          if (k in baseline.keys) {
            delete baseline.keys[k];
            changed = true;
          }
        }
        if (changed) {
          await redis.setex(
            QUOTA_TOTAL_COST_BASELINE_KEY,
            BASELINE_TTL_SECONDS,
            JSON.stringify(baseline)
          );
        }
      }
    }
  } catch (error) {
    logger.warn("[QuotaTotalCostCache] Failed to invalidate cache", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
