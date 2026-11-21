import { createHash, randomUUID } from "node:crypto";
import { logger } from "@/lib/logger";
import {
  type KeyTotalCostTarget,
  sumUserAndKeyTotalCostBatch,
  type UserAndKeyTotalCostResult,
  type UserTotalCostTarget,
} from "@/repository/statistics";
import { getRedisClient } from "./client";
import { scanPattern } from "./scan-helper";

export const QUOTA_TOTAL_COST_CACHE_PREFIX = "quota:users:total_cost:v1:";

const CACHE_TTL_SECONDS = 60;
const LOCK_TTL_SECONDS = 60;
const RETRY_INTERVAL_MS = 200;
const MAX_LOCK_WAIT_RETRIES = 125; // up to 25s waiting for another worker's single-pass scan
const RELEASE_LOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

interface SerializedTotalCostPayload {
  userCosts: Array<[number, number]>;
  keyCosts: Array<[number, number]>;
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

/**
 * Build a deterministic, secret-free cache key from entity IDs and resetAt
 * timestamps. Any user/key addition, removal, or costResetAt change produces
 * a new cache key immediately.
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

function serializeResult(result: UserAndKeyTotalCostResult): string {
  const payload: SerializedTotalCostPayload = {
    userCosts: Array.from(result.userCosts.entries()),
    keyCosts: Array.from(result.keyCosts.entries()),
  };
  return JSON.stringify(payload);
}

function deserializeResult(raw: string): UserAndKeyTotalCostResult | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SerializedTotalCostPayload>;
    if (!Array.isArray(parsed.userCosts) || !Array.isArray(parsed.keyCosts)) {
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

async function computeWithRedisCache(
  cacheKey: string,
  users: readonly UserTotalCostTarget[],
  keys: readonly KeyTotalCostTarget[],
  maxAgeDays: number
): Promise<UserAndKeyTotalCostResult> {
  const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
  if (redis?.status !== "ready") {
    return await sumUserAndKeyTotalCostBatch(users, keys, maxAgeDays);
  }

  const lockKey = `${cacheKey}:lock`;
  const lockToken = randomUUID();
  let locked = false;
  let computed: UserAndKeyTotalCostResult | undefined;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      const parsed = deserializeResult(cached);
      if (parsed) {
        return parsed;
      }
    }

    const lockResult = await redis.set(lockKey, lockToken, "EX", LOCK_TTL_SECONDS, "NX");
    locked = lockResult === "OK";

    if (locked) {
      computed = await sumUserAndKeyTotalCostBatch(users, keys, maxAgeDays);
      try {
        await redis.setex(cacheKey, CACHE_TTL_SECONDS, serializeResult(computed));
      } catch (writeErr) {
        logger.warn("[QuotaTotalCostCache] Failed to write cache", {
          cacheKey,
          error: writeErr instanceof Error ? writeErr.message : String(writeErr),
        });
      }
      return computed;
    }

    // Another worker is computing the single-pass aggregation; wait for the cached value.
    for (let i = 0; i < MAX_LOCK_WAIT_RETRIES; i++) {
      await sleep(RETRY_INTERVAL_MS);
      const retried = await redis.get(cacheKey);
      if (retried) {
        const parsed = deserializeResult(retried);
        if (parsed) {
          return parsed;
        }
      }
    }

    logger.warn("[QuotaTotalCostCache] Lock wait timeout, falling back to direct query", {
      cacheKey,
    });
    return await sumUserAndKeyTotalCostBatch(users, keys, maxAgeDays);
  } catch (error) {
    logger.warn("[QuotaTotalCostCache] Redis error, falling back to direct query", {
      cacheKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return computed ?? (await sumUserAndKeyTotalCostBatch(users, keys, maxAgeDays));
  } finally {
    if (locked) {
      const releasePromise =
        typeof redis.eval === "function"
          ? redis.eval(RELEASE_LOCK_LUA, 1, lockKey, lockToken)
          : redis.del(lockKey);
      await releasePromise.catch((err) => {
        logger.warn("[QuotaTotalCostCache] Failed to release lock", {
          lockKey,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }
}

/**
 * Fetch all-time user & key total costs with in-process singleflight +
 * short-TTL Redis caching (60s) backed by a single-pass SQL aggregation.
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

  const promise = computeWithRedisCache(cacheKey, users, keys, maxAgeDays).finally(() => {
    inFlightRequests.delete(cacheKey);
  });
  inFlightRequests.set(cacheKey, promise);
  return promise;
}

/**
 * Invalidate cached user/key total cost snapshots (called on explicit cost resets).
 */
export async function invalidateQuotaTotalCostCache(): Promise<void> {
  const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
  if (redis?.status !== "ready") {
    return;
  }

  try {
    const matched = await scanPattern(redis, `${QUOTA_TOTAL_COST_CACHE_PREFIX}*`);
    const cacheKeys = matched.filter((key) => !key.endsWith(":lock"));
    if (cacheKeys.length > 0) {
      await redis.del(...cacheKeys);
    }
  } catch (error) {
    logger.warn("[QuotaTotalCostCache] Failed to invalidate cache", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
