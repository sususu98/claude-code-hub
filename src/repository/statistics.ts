import "server-only";

import { fromZonedTime } from "date-fns-tz";
import type { SQL } from "drizzle-orm";
import { and, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/drizzle/db";
import { keys, messageRequest, usageLedger } from "@/drizzle/schema";
import { TTLMap } from "@/lib/cache/ttl-map";
import { Decimal } from "@/lib/utils/currency";
import { resolveSystemTimezone } from "@/lib/utils/timezone";
import type {
  DatabaseKey,
  DatabaseKeyStatRow,
  DatabaseStatRow,
  DatabaseUser,
  RateLimitEventFilters,
  RateLimitEventStats,
  RateLimitType,
  TimeRange,
} from "@/types/statistics";
import { LEDGER_BILLING_CONDITION } from "./_shared/ledger-conditions";
import { EXCLUDE_WARMUP_CONDITION } from "./_shared/message-request-conditions";

/**
 * Key ID -> key string cache
 *
 * Short TTL allows slight staleness (keys rarely change).
 * Size-bounded to avoid unbounded growth in multi-tenant scenarios.
 */
const keyStringByIdCache = new TTLMap<number, string>({ ttlMs: 5 * 60 * 1000, maxSize: 1000 });

async function getKeyStringByIdCached(keyId: number): Promise<string | null> {
  const cached = keyStringByIdCache.get(keyId);
  if (cached !== undefined) return cached;

  const keyRecord = await db
    .select({ key: keys.key })
    .from(keys)
    .where(eq(keys.id, keyId))
    .limit(1);

  const keyString = keyRecord?.[0]?.key ?? null;
  if (!keyString) return null;

  keyStringByIdCache.set(keyId, keyString);
  return keyString;
}

type SqlTimeRangeConfig = {
  startTs: ReturnType<typeof sql>;
  endTs: ReturnType<typeof sql>;
  bucketExpr: ReturnType<typeof sql>;
  bucketSeriesQuery: ReturnType<typeof sql>;
};

type TimeBucketValue = Date | string | null;

type UserBucketStatsRow = {
  user_id: number;
  user_name: string;
  bucket: TimeBucketValue;
  api_calls: number | string | null;
  total_cost: string | number | null;
};

type KeyBucketStatsRow = {
  key_id: number;
  key_name: string;
  bucket: TimeBucketValue;
  api_calls: number | string | null;
  total_cost: string | number | null;
};

type MixedOthersBucketStatsRow = {
  bucket: TimeBucketValue;
  api_calls: number | string | null;
  total_cost: string | number | null;
};

type RuntimeDatabaseStatRow = Omit<DatabaseStatRow, "date"> & { date: Date };
type RuntimeDatabaseKeyStatRow = Omit<DatabaseKeyStatRow, "date"> & { date: Date };

function getTimeRangeSqlConfig(timeRange: TimeRange, timezone: string): SqlTimeRangeConfig {
  switch (timeRange) {
    case "today":
      return {
        startTs: sql`(DATE_TRUNC('day', CURRENT_TIMESTAMP AT TIME ZONE ${timezone}) AT TIME ZONE ${timezone})`,
        endTs: sql`((DATE_TRUNC('day', CURRENT_TIMESTAMP AT TIME ZONE ${timezone}) + INTERVAL '1 day') AT TIME ZONE ${timezone})`,
        bucketExpr: sql`DATE_TRUNC('hour', usage_ledger.created_at AT TIME ZONE ${timezone})`,
        bucketSeriesQuery: sql`
          SELECT generate_series(
            DATE_TRUNC('day', CURRENT_TIMESTAMP AT TIME ZONE ${timezone}),
            DATE_TRUNC('day', CURRENT_TIMESTAMP AT TIME ZONE ${timezone}) + INTERVAL '23 hours',
            '1 hour'::interval
          ) AS bucket
        `,
      };
    case "7days":
      return {
        startTs: sql`((DATE_TRUNC('day', CURRENT_TIMESTAMP AT TIME ZONE ${timezone}) - INTERVAL '6 days') AT TIME ZONE ${timezone})`,
        endTs: sql`((DATE_TRUNC('day', CURRENT_TIMESTAMP AT TIME ZONE ${timezone}) + INTERVAL '1 day') AT TIME ZONE ${timezone})`,
        bucketExpr: sql`DATE_TRUNC('day', usage_ledger.created_at AT TIME ZONE ${timezone})`,
        bucketSeriesQuery: sql`
          SELECT generate_series(
            (CURRENT_TIMESTAMP AT TIME ZONE ${timezone})::date - INTERVAL '6 days',
            (CURRENT_TIMESTAMP AT TIME ZONE ${timezone})::date,
            '1 day'::interval
          ) AS bucket
        `,
      };
    case "30days":
      return {
        startTs: sql`((DATE_TRUNC('day', CURRENT_TIMESTAMP AT TIME ZONE ${timezone}) - INTERVAL '29 days') AT TIME ZONE ${timezone})`,
        endTs: sql`((DATE_TRUNC('day', CURRENT_TIMESTAMP AT TIME ZONE ${timezone}) + INTERVAL '1 day') AT TIME ZONE ${timezone})`,
        bucketExpr: sql`DATE_TRUNC('day', usage_ledger.created_at AT TIME ZONE ${timezone})`,
        bucketSeriesQuery: sql`
          SELECT generate_series(
            (CURRENT_TIMESTAMP AT TIME ZONE ${timezone})::date - INTERVAL '29 days',
            (CURRENT_TIMESTAMP AT TIME ZONE ${timezone})::date,
            '1 day'::interval
          ) AS bucket
        `,
      };
    case "thisMonth":
      return {
        startTs: sql`((DATE_TRUNC('month', CURRENT_TIMESTAMP AT TIME ZONE ${timezone})) AT TIME ZONE ${timezone})`,
        endTs: sql`((DATE_TRUNC('day', CURRENT_TIMESTAMP AT TIME ZONE ${timezone}) + INTERVAL '1 day') AT TIME ZONE ${timezone})`,
        bucketExpr: sql`DATE_TRUNC('day', usage_ledger.created_at AT TIME ZONE ${timezone})`,
        bucketSeriesQuery: sql`
          SELECT generate_series(
            DATE_TRUNC('month', CURRENT_TIMESTAMP AT TIME ZONE ${timezone}),
            DATE_TRUNC('day', CURRENT_TIMESTAMP AT TIME ZONE ${timezone}),
            '1 day'::interval
          ) AS bucket
        `,
      };
    default:
      throw new Error(`Unsupported time range: ${timeRange}`);
  }
}

function formatLocalDateTime(value: Date): string {
  const year = value.getFullYear();
  const month = `${value.getMonth() + 1}`.padStart(2, "0");
  const day = `${value.getDate()}`.padStart(2, "0");
  const hours = `${value.getHours()}`.padStart(2, "0");
  const minutes = `${value.getMinutes()}`.padStart(2, "0");
  const seconds = `${value.getSeconds()}`.padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}

function normalizeBucketInstant(value: TimeBucketValue, timezone: string): Date | null {
  if (!value) return null;

  let localDateTime: string;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    localDateTime = formatLocalDateTime(value);
  } else {
    const match =
      /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(
        value
      );
    if (!match) return null;
    localDateTime = `${match[1]}T${match[2]}`;
  }

  const parsed = fromZonedTime(localDateTime, timezone);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeApiCalls(value: number | string | null): number {
  const normalized = Number(value ?? 0);
  return Number.isFinite(normalized) ? normalized : 0;
}

function normalizeTotalCost(value: string | number | null): string | number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  return value;
}

async function getTimeBuckets(timeRange: TimeRange, timezone: string): Promise<Date[]> {
  const { bucketSeriesQuery } = getTimeRangeSqlConfig(timeRange, timezone);
  const result = await db.execute(bucketSeriesQuery);
  return (Array.from(result) as Array<{ bucket: TimeBucketValue }>)
    .map((row) => normalizeBucketInstant(row.bucket, timezone))
    .filter((bucket): bucket is Date => bucket !== null)
    .sort((a, b) => a.getTime() - b.getTime());
}

function zeroFillUserStats(
  dbRows: UserBucketStatsRow[],
  allUsers: Array<{ id: number; name: string }>,
  buckets: Date[],
  timezone: string
): RuntimeDatabaseStatRow[] {
  const rowMap = new Map<string, { api_calls: number; total_cost: string | number }>();
  for (const row of dbRows) {
    const bucket = normalizeBucketInstant(row.bucket, timezone);
    if (!bucket) continue;

    rowMap.set(`${row.user_id}:${bucket.getTime()}`, {
      api_calls: normalizeApiCalls(row.api_calls),
      total_cost: normalizeTotalCost(row.total_cost),
    });
  }

  const sortedUsers = [...allUsers].sort((a, b) => a.name.localeCompare(b.name));
  const filledRows: RuntimeDatabaseStatRow[] = [];

  for (const bucket of buckets) {
    const bucketTime = bucket.getTime();
    for (const user of sortedUsers) {
      const row = rowMap.get(`${user.id}:${bucketTime}`);
      filledRows.push({
        user_id: user.id,
        user_name: user.name,
        date: new Date(bucketTime),
        api_calls: row?.api_calls ?? 0,
        total_cost: row?.total_cost ?? 0,
      });
    }
  }

  return filledRows;
}

function zeroFillKeyStats(
  dbRows: KeyBucketStatsRow[],
  allKeys: Array<{ id: number; name: string }>,
  buckets: Date[],
  timezone: string
): RuntimeDatabaseKeyStatRow[] {
  const rowMap = new Map<string, { api_calls: number; total_cost: string | number }>();
  for (const row of dbRows) {
    const bucket = normalizeBucketInstant(row.bucket, timezone);
    if (!bucket) continue;

    rowMap.set(`${row.key_id}:${bucket.getTime()}`, {
      api_calls: normalizeApiCalls(row.api_calls),
      total_cost: normalizeTotalCost(row.total_cost),
    });
  }

  const sortedKeys = [...allKeys].sort((a, b) => a.name.localeCompare(b.name));
  const filledRows: RuntimeDatabaseKeyStatRow[] = [];

  for (const bucket of buckets) {
    const bucketTime = bucket.getTime();
    for (const key of sortedKeys) {
      const row = rowMap.get(`${key.id}:${bucketTime}`);
      filledRows.push({
        key_id: key.id,
        key_name: key.name,
        date: new Date(bucketTime),
        api_calls: row?.api_calls ?? 0,
        total_cost: row?.total_cost ?? 0,
      });
    }
  }

  return filledRows;
}

function zeroFillMixedOthersStats(
  dbRows: MixedOthersBucketStatsRow[],
  buckets: Date[],
  timezone: string
): RuntimeDatabaseStatRow[] {
  const rowMap = new Map<number, { api_calls: number; total_cost: string | number }>();
  for (const row of dbRows) {
    const bucket = normalizeBucketInstant(row.bucket, timezone);
    if (!bucket) continue;

    rowMap.set(bucket.getTime(), {
      api_calls: normalizeApiCalls(row.api_calls),
      total_cost: normalizeTotalCost(row.total_cost),
    });
  }

  return buckets.map((bucket) => {
    const row = rowMap.get(bucket.getTime());
    return {
      user_id: -1,
      user_name: "__others__",
      date: new Date(bucket.getTime()),
      api_calls: row?.api_calls ?? 0,
      total_cost: row?.total_cost ?? 0,
    };
  });
}

/**
 * 根据时间范围获取用户消费和API调用统计
 */
export async function getUserStatisticsFromDB(
  timeRange: TimeRange,
  timezoneOverride?: string
): Promise<DatabaseStatRow[]> {
  const timezone = timezoneOverride ?? (await resolveSystemTimezone());
  const { startTs, endTs, bucketExpr } = getTimeRangeSqlConfig(timeRange, timezone);

  const statsQuery = sql`
    SELECT
      u.id AS user_id,
      u.name AS user_name,
      ${bucketExpr} AS bucket,
      COUNT(usage_ledger.id) AS api_calls,
      COALESCE(SUM(usage_ledger.cost_usd), 0) AS total_cost
    FROM users u
    LEFT JOIN usage_ledger ON u.id = usage_ledger.user_id
      AND usage_ledger.created_at >= ${startTs}
      AND usage_ledger.created_at < ${endTs}
      AND ${LEDGER_BILLING_CONDITION}
    WHERE u.deleted_at IS NULL
    GROUP BY u.id, u.name, bucket
    ORDER BY bucket ASC, u.name ASC
  `;

  const [users, buckets, statsResult] = await Promise.all([
    getActiveUsersFromDB(),
    getTimeBuckets(timeRange, timezone),
    db.execute(statsQuery),
  ]);

  const rows = Array.from(statsResult) as UserBucketStatsRow[];
  return zeroFillUserStats(rows, users, buckets, timezone) as unknown as DatabaseStatRow[];
}

/**
 * 获取所有活跃用户列表
 */
export async function getActiveUsersFromDB(): Promise<DatabaseUser[]> {
  const query = sql`
    SELECT id, name
    FROM users
    WHERE deleted_at IS NULL
    ORDER BY name ASC
  `;

  const result = await db.execute(query);
  return Array.from(result) as unknown as DatabaseUser[];
}

/**
 * 获取指定用户的密钥使用统计
 */
export async function getKeyStatisticsFromDB(
  userId: number,
  timeRange: TimeRange,
  timezoneOverride?: string
): Promise<DatabaseKeyStatRow[]> {
  const timezone = timezoneOverride ?? (await resolveSystemTimezone());
  const { startTs, endTs, bucketExpr } = getTimeRangeSqlConfig(timeRange, timezone);

  const statsQuery = sql`
    SELECT
      k.id AS key_id,
      k.name AS key_name,
      ${bucketExpr} AS bucket,
      COUNT(usage_ledger.id) AS api_calls,
      COALESCE(SUM(usage_ledger.cost_usd), 0) AS total_cost
    FROM keys k
    LEFT JOIN usage_ledger ON usage_ledger.key = k.key
      AND usage_ledger.user_id = ${userId}
      AND usage_ledger.created_at >= ${startTs}
      AND usage_ledger.created_at < ${endTs}
      AND ${LEDGER_BILLING_CONDITION}
    WHERE k.user_id = ${userId}
      AND k.deleted_at IS NULL
    GROUP BY k.id, k.name, bucket
    ORDER BY bucket ASC, k.name ASC
  `;

  const [activeKeys, buckets, statsResult] = await Promise.all([
    getActiveKeysForUserFromDB(userId),
    getTimeBuckets(timeRange, timezone),
    db.execute(statsQuery),
  ]);

  const rows = Array.from(statsResult) as KeyBucketStatsRow[];
  return zeroFillKeyStats(rows, activeKeys, buckets, timezone) as unknown as DatabaseKeyStatRow[];
}

/**
 * 获取指定用户的有效密钥列表
 */
export async function getActiveKeysForUserFromDB(userId: number): Promise<DatabaseKey[]> {
  const query = sql`
    SELECT id, name
    FROM keys
    WHERE user_id = ${userId}
      AND deleted_at IS NULL
    ORDER BY name ASC
  `;

  const result = await db.execute(query);
  return Array.from(result) as unknown as DatabaseKey[];
}

/**
 * 获取混合统计数据：当前用户的密钥明细 + 其他用户的汇总
 * 用于非 admin 用户在 allowGlobalUsageView=true 时的数据展示
 */
export async function getMixedStatisticsFromDB(
  userId: number,
  timeRange: TimeRange,
  timezoneOverride?: string
): Promise<{
  ownKeys: DatabaseKeyStatRow[];
  othersAggregate: DatabaseStatRow[];
}> {
  const timezone = timezoneOverride ?? (await resolveSystemTimezone());
  const { startTs, endTs, bucketExpr } = getTimeRangeSqlConfig(timeRange, timezone);

  const ownKeysQuery = sql`
    SELECT
      k.id AS key_id,
      k.name AS key_name,
      ${bucketExpr} AS bucket,
      COUNT(usage_ledger.id) AS api_calls,
      COALESCE(SUM(usage_ledger.cost_usd), 0) AS total_cost
    FROM keys k
    LEFT JOIN usage_ledger ON usage_ledger.key = k.key
      AND usage_ledger.user_id = ${userId}
      AND usage_ledger.created_at >= ${startTs}
      AND usage_ledger.created_at < ${endTs}
      AND ${LEDGER_BILLING_CONDITION}
    WHERE k.user_id = ${userId}
      AND k.deleted_at IS NULL
    GROUP BY k.id, k.name, bucket
    ORDER BY bucket ASC, k.name ASC
  `;

  const othersQuery = sql`
    SELECT
      ${bucketExpr} AS bucket,
      COUNT(usage_ledger.id) AS api_calls,
      COALESCE(SUM(usage_ledger.cost_usd), 0) AS total_cost
    FROM usage_ledger
    WHERE usage_ledger.user_id <> ${userId}
      AND usage_ledger.created_at >= ${startTs}
      AND usage_ledger.created_at < ${endTs}
      AND ${LEDGER_BILLING_CONDITION}
    GROUP BY bucket
    ORDER BY bucket ASC
  `;

  const [activeKeys, buckets, ownKeysResult, othersResult] = await Promise.all([
    getActiveKeysForUserFromDB(userId),
    getTimeBuckets(timeRange, timezone),
    db.execute(ownKeysQuery),
    db.execute(othersQuery),
  ]);

  return {
    ownKeys: zeroFillKeyStats(
      Array.from(ownKeysResult) as KeyBucketStatsRow[],
      activeKeys,
      buckets,
      timezone
    ) as unknown as DatabaseKeyStatRow[],
    othersAggregate: zeroFillMixedOthersStats(
      Array.from(othersResult) as MixedOthersBucketStatsRow[],
      buckets,
      timezone
    ) as unknown as DatabaseStatRow[],
  };
}

/**
 * 查询用户今日总消费（所有 Key 的消费总和）
 * 用于用户层每日限额检查（Redis 降级）
 *
 * DEPRECATED: 该函数使用简单的日期比较，不考虑用户的 dailyResetTime 配置。
 * 请使用 sumUserCostInTimeRange() 配合 getTimeRangeForPeriodWithMode() 来获取正确的时间范围。
 *
 * @deprecated 使用 sumUserCostInTimeRange() 替代
 */
export async function sumUserCostToday(userId: number): Promise<number> {
  const timezone = await resolveSystemTimezone();

  const query = sql`
    SELECT COALESCE(SUM(usage_ledger.cost_usd), 0) AS total_cost
    FROM usage_ledger
    WHERE usage_ledger.user_id = ${userId}
      AND (usage_ledger.created_at AT TIME ZONE ${timezone})::date = (CURRENT_TIMESTAMP AT TIME ZONE ${timezone})::date
      AND ${LEDGER_BILLING_CONDITION}
  `;

  const result = await db.execute(query);
  const row = Array.from(result)[0] as { total_cost?: string | number } | undefined;
  return Number(row?.total_cost || 0);
}

/**
 * Query Key total cost (with optional time boundary)
 * @param keyHash - API Key hash
 * @param maxAgeDays - Max query days (default 365). Use Infinity for all-time.
 */
export async function sumKeyTotalCost(
  keyHash: string,
  maxAgeDays: number = 365,
  resetAt?: Date | null
): Promise<number> {
  const conditions = [eq(usageLedger.key, keyHash), LEDGER_BILLING_CONDITION];

  // Use the more recent of resetAt and maxAgeDays cutoff
  const maxAgeCutoff =
    Number.isFinite(maxAgeDays) && maxAgeDays > 0
      ? new Date(Date.now() - Math.floor(maxAgeDays) * 24 * 60 * 60 * 1000)
      : null;
  let cutoff = maxAgeCutoff;
  if (resetAt instanceof Date && !Number.isNaN(resetAt.getTime())) {
    cutoff = maxAgeCutoff && maxAgeCutoff > resetAt ? maxAgeCutoff : resetAt;
  }
  if (cutoff) {
    conditions.push(gte(usageLedger.createdAt, cutoff));
  }

  const result = await db
    .select({ total: sql<number>`COALESCE(SUM(${usageLedger.costUsd}), 0)` })
    .from(usageLedger)
    .where(and(...conditions));

  return Number(result[0]?.total || 0);
}

/**
 * Query user total cost across all keys (with optional time boundary)
 * @param userId - User ID
 * @param maxAgeDays - Max query days (default 365). Use Infinity for all-time.
 */
export async function sumUserTotalCost(
  userId: number,
  maxAgeDays: number = 365,
  resetAt?: Date | null
): Promise<number> {
  const conditions = [eq(usageLedger.userId, userId), LEDGER_BILLING_CONDITION];

  // Use the more recent of resetAt and maxAgeDays cutoff
  const maxAgeCutoff =
    Number.isFinite(maxAgeDays) && maxAgeDays > 0
      ? new Date(Date.now() - Math.floor(maxAgeDays) * 24 * 60 * 60 * 1000)
      : null;
  let cutoff = maxAgeCutoff;
  if (resetAt instanceof Date && !Number.isNaN(resetAt.getTime())) {
    cutoff = maxAgeCutoff && maxAgeCutoff > resetAt ? maxAgeCutoff : resetAt;
  }
  if (cutoff) {
    conditions.push(gte(usageLedger.createdAt, cutoff));
  }

  const result = await db
    .select({ total: sql<number>`COALESCE(SUM(${usageLedger.costUsd}), 0)` })
    .from(usageLedger)
    .where(and(...conditions));

  return Number(result[0]?.total || 0);
}

function isValidResetAt(resetAt: Date | null | undefined): resetAt is Date {
  return resetAt instanceof Date && !Number.isNaN(resetAt.getTime());
}

/**
 * Resolve the effective lower bound for a total-cost query: the later of the
 * max-age cutoff and a valid reset timestamp. Returns null for all-time.
 */
function resolveTotalCostCutoff(maxAgeDays: number, resetAt?: Date | null): Date | null {
  const maxAgeCutoff =
    Number.isFinite(maxAgeDays) && maxAgeDays > 0
      ? new Date(Date.now() - Math.floor(maxAgeDays) * 24 * 60 * 60 * 1000)
      : null;
  if (isValidResetAt(resetAt)) {
    return maxAgeCutoff && maxAgeCutoff > resetAt ? maxAgeCutoff : resetAt;
  }
  return maxAgeCutoff;
}

// Keep each VALUES-join statement well below the driver parameter limit.
const TOTAL_COST_CUTOFF_CHUNK_SIZE = 1000;

interface TotalCostCutoffEntry {
  entityKey: number | string;
  cutoff: Date;
}

/**
 * Total cost for entities that each carry their own cutoff, aggregated in a
 * single SQL statement (per chunk) instead of one query per entity.
 *
 * A per-entity Promise.all fan-out here can exceed the database pool
 * admission limit on fan-out pages such as the user quota list (issue #1511).
 * Returns Map of String(entityKey) -> totalCost. Duplicate entity keys keep
 * the last cutoff, matching the previous per-entity overwrite order.
 */
async function sumTotalCostWithCutoffs(
  entityType: "user" | "key",
  entries: readonly TotalCostCutoffEntry[]
): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  const entityColumn = entityType === "user" ? usageLedger.userId : usageLedger.key;

  const deduped = new Map<string, TotalCostCutoffEntry>();
  for (const entry of entries) {
    deduped.set(String(entry.entityKey), entry);
  }
  const uniqueEntries = [...deduped.values()];

  for (let start = 0; start < uniqueEntries.length; start += TOTAL_COST_CUTOFF_CHUNK_SIZE) {
    const chunk = uniqueEntries.slice(start, start + TOTAL_COST_CUTOFF_CHUNK_SIZE);
    const valueRows = chunk.map((entry) =>
      entityType === "user"
        ? sql`(${entry.entityKey as number}::int, ${entry.cutoff.toISOString()}::timestamptz)`
        : sql`(${entry.entityKey as string}::varchar, ${entry.cutoff.toISOString()}::timestamptz)`
    );

    // Use CROSS JOIN LATERAL so PostgreSQL performs an Index Only Scan on
    // idx_usage_ledger_user_cost_cover / idx_usage_ledger_key_cost per entity
    // instead of degrading into a single-threaded Hash Right Join Seq Scan.
    const rows = await db.execute(sql`
      SELECT c.entity_id AS entity_id, COALESCE(agg.total, 0) AS total
      FROM (VALUES ${sql.join(valueRows, sql`, `)}) AS c(entity_id, cutoff)
      CROSS JOIN LATERAL (
        SELECT SUM(${usageLedger.costUsd}) AS total
        FROM ${usageLedger}
        WHERE ${entityColumn} = c.entity_id
          AND ${usageLedger.createdAt} >= c.cutoff
          AND ${LEDGER_BILLING_CONDITION}
      ) AS agg
    `);

    for (const row of Array.from(rows) as Array<{ entity_id: unknown; total: unknown }>) {
      totals.set(String(row.entity_id), Number(row.total || 0));
    }
  }

  return totals;
}

/**
 * Batch query: total cost grouped by user_id (single SQL query)
 * @param userIds - Array of user IDs
 * @param maxAgeDays - Only include records newer than this many days (default 365, use Infinity to include all)
 * @returns Map of userId -> totalCost
 */
export async function sumUserTotalCostBatch(
  userIds: number[],
  maxAgeDays: number = 365,
  resetAtMap?: Map<number, Date>
): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  if (userIds.length === 0) return result;
  for (const id of userIds) result.set(id, 0);

  // Split users: those with a valid costResetAt carry their own cutoff and
  // are aggregated in a single statement. An invalid reset date behaves
  // like no reset, matching sumUserTotalCost.
  const resetEntries: Array<{ id: number; cutoff: Date }> = [];
  const batchUserIds: number[] = [];
  for (const id of userIds) {
    const resetAt = resetAtMap?.get(id);
    if (isValidResetAt(resetAt)) {
      // A valid reset always yields a cutoff (at least the reset itself).
      resetEntries.push({ id, cutoff: resolveTotalCostCutoff(maxAgeDays, resetAt) as Date });
    } else {
      batchUserIds.push(id);
    }
  }

  if (resetEntries.length > 0) {
    const resetTotals = await sumTotalCostWithCutoffs(
      "user",
      resetEntries.map(({ id, cutoff }) => ({ entityKey: id, cutoff }))
    );
    for (const { id } of resetEntries) {
      result.set(id, resetTotals.get(String(id)) ?? 0);
    }
  }

  // Batch query for users without costResetAt
  if (batchUserIds.length > 0) {
    const conditions: SQL[] = [inArray(usageLedger.userId, batchUserIds), LEDGER_BILLING_CONDITION];
    if (Number.isFinite(maxAgeDays) && maxAgeDays > 0) {
      const cutoffDate = new Date(Date.now() - Math.floor(maxAgeDays) * 24 * 60 * 60 * 1000);
      conditions.push(gte(usageLedger.createdAt, cutoffDate));
    }

    const rows = await db
      .select({
        userId: usageLedger.userId,
        total: sql<number>`COALESCE(SUM(${usageLedger.costUsd}), 0)`,
      })
      .from(usageLedger)
      .where(and(...conditions))
      .groupBy(usageLedger.userId);

    for (const row of rows) result.set(row.userId, Number(row.total || 0));
  }

  return result;
}

/**
 * Batch query: total cost grouped by key_id using a two-step PK lookup then aggregate.
 * Avoids varchar LEFT JOIN by first resolving key strings via PK, then aggregating on
 * usage_ledger directly (hits idx_usage_ledger_key_cost index).
 * @param keyIds - Array of key IDs
 * @param maxAgeDays - Only include records newer than this many days (default 365, use Infinity to include all)
 * @returns Map of keyId -> totalCost
 */
export async function sumKeyTotalCostBatchByIds(
  keyIds: number[],
  maxAgeDays: number = 365,
  resetAtMap?: Map<number, Date>
): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  if (keyIds.length === 0) return result;
  for (const id of keyIds) result.set(id, 0);

  // Step 1: PK lookup -> key strings
  const keyMappings = await db
    .select({ id: keys.id, key: keys.key })
    .from(keys)
    .where(inArray(keys.id, keyIds));

  const keyStringToId = new Map(keyMappings.map((k) => [k.key, k.id]));
  const keyStrings = keyMappings.map((k) => k.key);
  if (keyStrings.length === 0) return result;

  // Split keys: those with a valid costResetAt carry their own cutoff and
  // are aggregated in a single statement. An invalid reset date behaves
  // like no reset, matching sumKeyTotalCost.
  const resetEntries: Array<{ id: number; keyString: string; cutoff: Date }> = [];
  const batchKeyStrings: string[] = [];
  for (const mapping of keyMappings) {
    const resetAt = resetAtMap?.get(mapping.id);
    if (isValidResetAt(resetAt)) {
      resetEntries.push({
        id: mapping.id,
        keyString: mapping.key,
        cutoff: resolveTotalCostCutoff(maxAgeDays, resetAt) as Date,
      });
    } else {
      batchKeyStrings.push(mapping.key);
    }
  }

  if (resetEntries.length > 0) {
    const resetTotals = await sumTotalCostWithCutoffs(
      "key",
      resetEntries.map(({ keyString, cutoff }) => ({ entityKey: keyString, cutoff }))
    );
    for (const { id, keyString } of resetEntries) {
      result.set(id, resetTotals.get(keyString) ?? 0);
    }
  }

  // Step 2: Batch aggregate for keys without costResetAt
  if (batchKeyStrings.length > 0) {
    const conditions: SQL[] = [inArray(usageLedger.key, batchKeyStrings), LEDGER_BILLING_CONDITION];
    if (Number.isFinite(maxAgeDays) && maxAgeDays > 0) {
      const cutoffDate = new Date(Date.now() - Math.floor(maxAgeDays) * 24 * 60 * 60 * 1000);
      conditions.push(gte(usageLedger.createdAt, cutoffDate));
    }

    const rows = await db
      .select({
        key: usageLedger.key,
        total: sql<number>`COALESCE(SUM(${usageLedger.costUsd}), 0)`,
      })
      .from(usageLedger)
      .where(and(...conditions))
      .groupBy(usageLedger.key);

    for (const row of rows) {
      const keyId = keyStringToId.get(row.key);
      if (keyId !== undefined) result.set(keyId, Number(row.total || 0));
    }
  }

  return result;
}

export interface UserTimeRangeCostEntry {
  userId: number;
  startTime: Date;
  endTime: Date;
}

export interface KeyTimeRangeCostEntry {
  keyId: number;
  key: string;
  startTime: Date;
  endTime: Date;
}

export interface UserTotalCostTarget {
  userId: number;
  resetAt?: Date | null;
}

export interface KeyTotalCostTarget {
  keyId: number;
  key: string;
  resetAt?: Date | null;
}

export interface UserAndKeyTotalCostResult {
  userCosts: Map<number, number>;
  keyCosts: Map<number, number>;
}

export interface UserAndKeySplitTotalCostResult {
  settledUserCosts: Map<number, number>;
  settledKeyCosts: Map<number, number>;
  liveUserCosts: Map<number, number>;
  liveKeyCosts: Map<number, number>;
}

// Keep combined single-pass VALUES parameter count well below PostgreSQL's 65,535 bind limit.
const SINGLE_PASS_TOTAL_COST_MAX_PARAMS = 50000;

/**
 * Batch query: sum user cost for per-user [startTime, endTime) windows using
 * a single VALUES + CROSS JOIN LATERAL statement per chunk.
 * Uses idx_usage_ledger_user_cost_cover without N+1 roundtrips.
 */
export async function sumUserCostInTimeRangesBatch(
  entries: readonly UserTimeRangeCostEntry[]
): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  if (entries.length === 0) return result;

  const deduped = new Map<number, UserTimeRangeCostEntry>();
  for (const entry of entries) {
    result.set(entry.userId, 0);
    deduped.set(entry.userId, entry);
  }

  const queryable = [...deduped.values()].filter(
    (entry) =>
      entry.startTime instanceof Date &&
      entry.endTime instanceof Date &&
      !Number.isNaN(entry.startTime.getTime()) &&
      !Number.isNaN(entry.endTime.getTime()) &&
      entry.startTime < entry.endTime
  );

  for (let start = 0; start < queryable.length; start += TOTAL_COST_CUTOFF_CHUNK_SIZE) {
    const chunk = queryable.slice(start, start + TOTAL_COST_CUTOFF_CHUNK_SIZE);
    const valueRows = chunk.map(
      (entry) =>
        sql`(${entry.userId}::int, ${entry.startTime.toISOString()}::timestamptz, ${entry.endTime.toISOString()}::timestamptz)`
    );

    const rows = await db.execute(sql`
      SELECT c.user_id AS user_id, COALESCE(agg.total, 0) AS total
      FROM (VALUES ${sql.join(valueRows, sql`, `)}) AS c(user_id, start_time, end_time)
      CROSS JOIN LATERAL (
        SELECT SUM(${usageLedger.costUsd}) AS total
        FROM ${usageLedger}
        WHERE ${usageLedger.userId} = c.user_id
          AND ${usageLedger.createdAt} >= c.start_time
          AND ${usageLedger.createdAt} < c.end_time
          AND ${LEDGER_BILLING_CONDITION}
      ) AS agg
    `);

    for (const row of Array.from(rows) as Array<{ user_id: unknown; total: unknown }>) {
      const userId = Number(row.user_id);
      if (result.has(userId)) {
        result.set(userId, Number(row.total || 0));
      }
    }
  }

  return result;
}

/**
 * Batch query: sum key cost for per-key [startTime, endTime) windows using
 * a single VALUES + CROSS JOIN LATERAL statement per chunk.
 * Uses idx_usage_ledger_key_cost without extra keys table lookups.
 */
export async function sumKeyCostInTimeRangesBatch(
  entries: readonly KeyTimeRangeCostEntry[]
): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  if (entries.length === 0) return result;

  const deduped = new Map<number, KeyTimeRangeCostEntry>();
  for (const entry of entries) {
    result.set(entry.keyId, 0);
    deduped.set(entry.keyId, entry);
  }

  const queryable = [...deduped.values()].filter(
    (entry) =>
      entry.key.length > 0 &&
      entry.startTime instanceof Date &&
      entry.endTime instanceof Date &&
      !Number.isNaN(entry.startTime.getTime()) &&
      !Number.isNaN(entry.endTime.getTime()) &&
      entry.startTime < entry.endTime
  );

  for (let start = 0; start < queryable.length; start += TOTAL_COST_CUTOFF_CHUNK_SIZE) {
    const chunk = queryable.slice(start, start + TOTAL_COST_CUTOFF_CHUNK_SIZE);
    const valueRows = chunk.map(
      (entry) =>
        sql`(${entry.keyId}::int, ${entry.key}::varchar, ${entry.startTime.toISOString()}::timestamptz, ${entry.endTime.toISOString()}::timestamptz)`
    );

    const rows = await db.execute(sql`
      SELECT c.key_id AS key_id, COALESCE(agg.total, 0) AS total
      FROM (VALUES ${sql.join(valueRows, sql`, `)}) AS c(key_id, key_str, start_time, end_time)
      CROSS JOIN LATERAL (
        SELECT SUM(${usageLedger.costUsd}) AS total
        FROM ${usageLedger}
        WHERE ${usageLedger.key} = c.key_str
          AND ${usageLedger.createdAt} >= c.start_time
          AND ${usageLedger.createdAt} < c.end_time
          AND ${LEDGER_BILLING_CONDITION}
      ) AS agg
    `);

    for (const row of Array.from(rows) as Array<{ key_id: unknown; total: unknown }>) {
      const keyId = Number(row.key_id);
      if (result.has(keyId)) {
        result.set(keyId, Number(row.total || 0));
      }
    }
  }

  return result;
}

/**
 * Single-pass batch query for both user and key total costs (with independent
 * per-user and per-key reset cutoffs).
 *
 * Scanning usage_ledger once and grouping by (user_id, kt.key_id) avoids running
 * separate full-table scans for user totals, key totals, and reset-cutoff subsets.
 */
export async function sumUserAndKeyTotalCostBatch(
  usersInput: readonly UserTotalCostTarget[],
  keysInput: readonly KeyTotalCostTarget[],
  maxAgeDays: number = Infinity
): Promise<UserAndKeyTotalCostResult> {
  const userCosts = new Map<number, number>();
  const keyCosts = new Map<number, number>();

  const dedupedUsers = new Map<number, { userId: number; cutoff: Date | null }>();
  for (const user of usersInput) {
    userCosts.set(user.userId, 0);
    dedupedUsers.set(user.userId, {
      userId: user.userId,
      cutoff: resolveTotalCostCutoff(maxAgeDays, user.resetAt),
    });
  }

  const dedupedKeys = new Map<string, { keyId: number; key: string; cutoff: Date | null }>();
  for (const keyEntry of keysInput) {
    keyCosts.set(keyEntry.keyId, 0);
    if (keyEntry.key.length > 0) {
      dedupedKeys.set(keyEntry.key, {
        keyId: keyEntry.keyId,
        key: keyEntry.key,
        cutoff: resolveTotalCostCutoff(maxAgeDays, keyEntry.resetAt),
      });
    }
  }

  const uniqueUsers = [...dedupedUsers.values()];
  const uniqueKeys = [...dedupedKeys.values()];

  if (uniqueUsers.length === 0 && uniqueKeys.length === 0) {
    return { userCosts, keyCosts };
  }

  // Fallback to separate batch functions when one side is empty or bind count is extreme.
  const estimatedParams = uniqueUsers.length * 2 + uniqueKeys.length * 3;
  if (
    uniqueUsers.length === 0 ||
    uniqueKeys.length === 0 ||
    estimatedParams > SINGLE_PASS_TOTAL_COST_MAX_PARAMS
  ) {
    const userResetAtMap = new Map<number, Date>();
    for (const user of usersInput) {
      if (isValidResetAt(user.resetAt)) {
        userResetAtMap.set(user.userId, user.resetAt);
      }
    }
    const keyResetAtMap = new Map<number, Date>();
    for (const keyEntry of keysInput) {
      if (isValidResetAt(keyEntry.resetAt)) {
        keyResetAtMap.set(keyEntry.keyId, keyEntry.resetAt);
      }
    }

    const [fallbackUsers, fallbackKeys] = await Promise.all([
      uniqueUsers.length > 0
        ? sumUserTotalCostBatch(
            uniqueUsers.map((u) => u.userId),
            maxAgeDays,
            userResetAtMap.size > 0 ? userResetAtMap : undefined
          )
        : Promise.resolve(userCosts),
      uniqueKeys.length > 0
        ? sumKeyTotalCostBatchByIds(
            uniqueKeys.map((k) => k.keyId),
            maxAgeDays,
            keyResetAtMap.size > 0 ? keyResetAtMap : undefined
          )
        : Promise.resolve(keyCosts),
    ]);

    for (const [id, cost] of fallbackUsers) {
      userCosts.set(id, cost);
    }
    for (const [id, cost] of fallbackKeys) {
      keyCosts.set(id, cost);
    }
    return { userCosts, keyCosts };
  }

  // If every target carries a cutoff (e.g. finite maxAgeDays or all entities reset),
  // push the earliest cutoff down into the outer WHERE clause to prune older history.
  let minCutoff: Date | null = null;
  let allTargetsBounded = true;
  for (const u of uniqueUsers) {
    if (!u.cutoff) {
      allTargetsBounded = false;
      break;
    }
    if (!minCutoff || u.cutoff < minCutoff) {
      minCutoff = u.cutoff;
    }
  }
  if (allTargetsBounded) {
    for (const k of uniqueKeys) {
      if (!k.cutoff) {
        allTargetsBounded = false;
        break;
      }
      if (!minCutoff || k.cutoff < minCutoff) {
        minCutoff = k.cutoff;
      }
    }
  }
  const minCutoffClause =
    allTargetsBounded && minCutoff
      ? sql`AND ${usageLedger.createdAt} >= ${minCutoff.toISOString()}::timestamptz`
      : sql``;

  const userValueRows = uniqueUsers.map((u) =>
    u.cutoff
      ? sql`(${u.userId}::int, ${u.cutoff.toISOString()}::timestamptz)`
      : sql`(${u.userId}::int, NULL::timestamptz)`
  );
  const keyValueRows = uniqueKeys.map((k) =>
    k.cutoff
      ? sql`(${k.key}::varchar, ${k.keyId}::int, ${k.cutoff.toISOString()}::timestamptz)`
      : sql`(${k.key}::varchar, ${k.keyId}::int, NULL::timestamptz)`
  );

  const rows = await db.execute(sql`
    WITH user_targets(user_id, cutoff) AS (
      VALUES ${sql.join(userValueRows, sql`, `)}
    ),
    key_targets(key_str, key_id, cutoff) AS (
      VALUES ${sql.join(keyValueRows, sql`, `)}
    )
    SELECT
      ${usageLedger.userId} AS user_id,
      kt.key_id AS key_id,
      COALESCE(
        SUM(${usageLedger.costUsd}) FILTER (
          WHERE ut.user_id IS NOT NULL
            AND (ut.cutoff IS NULL OR ${usageLedger.createdAt} >= ut.cutoff)
        ),
        0
      ) AS user_cost,
      COALESCE(
        SUM(${usageLedger.costUsd}) FILTER (
          WHERE kt.key_id IS NOT NULL
            AND (kt.cutoff IS NULL OR ${usageLedger.createdAt} >= kt.cutoff)
        ),
        0
      ) AS key_cost
    FROM ${usageLedger}
    LEFT JOIN user_targets ut ON ut.user_id = ${usageLedger.userId}
    LEFT JOIN key_targets kt ON kt.key_str = ${usageLedger.key}
    WHERE (ut.user_id IS NOT NULL OR kt.key_id IS NOT NULL)
      ${minCutoffClause}
      AND ${LEDGER_BILLING_CONDITION}
    GROUP BY ${usageLedger.userId}, kt.key_id
  `);

  const userDecimals = new Map<number, Decimal>();
  const keyDecimals = new Map<number, Decimal>();

  for (const row of Array.from(rows) as Array<{
    user_id: unknown;
    key_id: unknown;
    user_cost: unknown;
    key_cost: unknown;
  }>) {
    const userId = Number(row.user_id);
    if (userCosts.has(userId) && row.user_cost != null) {
      const prev = userDecimals.get(userId) ?? new Decimal(0);
      userDecimals.set(userId, prev.plus(new Decimal(String(row.user_cost))));
    }

    if (row.key_id != null && row.key_cost != null) {
      const keyId = Number(row.key_id);
      if (keyCosts.has(keyId)) {
        const prev = keyDecimals.get(keyId) ?? new Decimal(0);
        keyDecimals.set(keyId, prev.plus(new Decimal(String(row.key_cost))));
      }
    }
  }

  for (const [userId, total] of userDecimals) {
    userCosts.set(userId, total.toNumber());
  }
  for (const [keyId, total] of keyDecimals) {
    keyCosts.set(keyId, total.toNumber());
  }

  return { userCosts, keyCosts };
}

/**
 * Single-pass batch query splitting user and key costs at `splitAt` into:
 * - settled: created_at < splitAt (finalized historical rows safe to persist in a watermarked baseline)
 * - live: created_at >= splitAt (recent/in-flight tail added on the fly without persisting)
 *
 * When `fromInclusive` is supplied, PostgreSQL uses idx_usage_ledger_created_at_desc_id
 * to scan only the incremental delta window (typically a few milliseconds).
 */
export async function sumUserAndKeyTotalCostWindowBatch(
  usersInput: readonly UserTotalCostTarget[],
  keysInput: readonly KeyTotalCostTarget[],
  options: {
    fromInclusive?: Date | null;
    splitAt: Date;
  }
): Promise<UserAndKeySplitTotalCostResult> {
  const settledUserCosts = new Map<number, number>();
  const settledKeyCosts = new Map<number, number>();
  const liveUserCosts = new Map<number, number>();
  const liveKeyCosts = new Map<number, number>();

  const dedupedUsers = new Map<number, { userId: number; cutoff: Date | null }>();
  for (const user of usersInput) {
    settledUserCosts.set(user.userId, 0);
    liveUserCosts.set(user.userId, 0);
    dedupedUsers.set(user.userId, {
      userId: user.userId,
      cutoff: resolveTotalCostCutoff(Infinity, user.resetAt),
    });
  }

  const dedupedKeys = new Map<string, { keyId: number; key: string; cutoff: Date | null }>();
  for (const keyEntry of keysInput) {
    settledKeyCosts.set(keyEntry.keyId, 0);
    liveKeyCosts.set(keyEntry.keyId, 0);
    if (keyEntry.key.length > 0) {
      dedupedKeys.set(keyEntry.key, {
        keyId: keyEntry.keyId,
        key: keyEntry.key,
        cutoff: resolveTotalCostCutoff(Infinity, keyEntry.resetAt),
      });
    }
  }

  const uniqueUsers = [...dedupedUsers.values()];
  const uniqueKeys = [...dedupedKeys.values()];
  if (uniqueUsers.length === 0 && uniqueKeys.length === 0) {
    return { settledUserCosts, settledKeyCosts, liveUserCosts, liveKeyCosts };
  }

  const fromInclusive =
    options.fromInclusive instanceof Date && !Number.isNaN(options.fromInclusive.getTime())
      ? options.fromInclusive
      : null;

  let minCutoffClause = sql``;
  if (fromInclusive) {
    minCutoffClause = sql`AND ${usageLedger.createdAt} >= ${fromInclusive.toISOString()}::timestamptz`;
  } else {
    let minCutoff: Date | null = null;
    let allTargetsBounded = true;
    for (const u of uniqueUsers) {
      if (!u.cutoff) {
        allTargetsBounded = false;
        break;
      }
      if (!minCutoff || u.cutoff < minCutoff) {
        minCutoff = u.cutoff;
      }
    }
    if (allTargetsBounded) {
      for (const k of uniqueKeys) {
        if (!k.cutoff) {
          allTargetsBounded = false;
          break;
        }
        if (!minCutoff || k.cutoff < minCutoff) {
          minCutoff = k.cutoff;
        }
      }
    }
    if (allTargetsBounded && minCutoff) {
      minCutoffClause = sql`AND ${usageLedger.createdAt} >= ${minCutoff.toISOString()}::timestamptz`;
    }
  }

  const userCte =
    uniqueUsers.length > 0
      ? sql`VALUES ${sql.join(
          uniqueUsers.map((u) =>
            u.cutoff
              ? sql`(${u.userId}::int, ${u.cutoff.toISOString()}::timestamptz)`
              : sql`(${u.userId}::int, NULL::timestamptz)`
          ),
          sql`, `
        )}`
      : sql`SELECT NULL::int AS user_id, NULL::timestamptz AS cutoff WHERE false`;

  const keyCte =
    uniqueKeys.length > 0
      ? sql`VALUES ${sql.join(
          uniqueKeys.map((k) =>
            k.cutoff
              ? sql`(${k.key}::varchar, ${k.keyId}::int, ${k.cutoff.toISOString()}::timestamptz)`
              : sql`(${k.key}::varchar, ${k.keyId}::int, NULL::timestamptz)`
          ),
          sql`, `
        )}`
      : sql`SELECT NULL::varchar AS key_str, NULL::int AS key_id, NULL::timestamptz AS cutoff WHERE false`;

  const splitAtIso = options.splitAt.toISOString();

  const rows = await db.execute(sql`
    WITH user_targets(user_id, cutoff) AS (
      ${userCte}
    ),
    key_targets(key_str, key_id, cutoff) AS (
      ${keyCte}
    )
    SELECT
      ${usageLedger.userId} AS user_id,
      kt.key_id AS key_id,
      COALESCE(
        SUM(${usageLedger.costUsd}) FILTER (
          WHERE ut.user_id IS NOT NULL
            AND ${usageLedger.createdAt} < ${splitAtIso}::timestamptz
            AND (ut.cutoff IS NULL OR ${usageLedger.createdAt} >= ut.cutoff)
        ),
        0
      ) AS settled_user_cost,
      COALESCE(
        SUM(${usageLedger.costUsd}) FILTER (
          WHERE ut.user_id IS NOT NULL
            AND ${usageLedger.createdAt} >= ${splitAtIso}::timestamptz
            AND (ut.cutoff IS NULL OR ${usageLedger.createdAt} >= ut.cutoff)
        ),
        0
      ) AS live_user_cost,
      COALESCE(
        SUM(${usageLedger.costUsd}) FILTER (
          WHERE kt.key_id IS NOT NULL
            AND ${usageLedger.createdAt} < ${splitAtIso}::timestamptz
            AND (kt.cutoff IS NULL OR ${usageLedger.createdAt} >= kt.cutoff)
        ),
        0
      ) AS settled_key_cost,
      COALESCE(
        SUM(${usageLedger.costUsd}) FILTER (
          WHERE kt.key_id IS NOT NULL
            AND ${usageLedger.createdAt} >= ${splitAtIso}::timestamptz
            AND (kt.cutoff IS NULL OR ${usageLedger.createdAt} >= kt.cutoff)
        ),
        0
      ) AS live_key_cost
    FROM ${usageLedger}
    LEFT JOIN user_targets ut ON ut.user_id = ${usageLedger.userId}
    LEFT JOIN key_targets kt ON kt.key_str = ${usageLedger.key}
    WHERE (ut.user_id IS NOT NULL OR kt.key_id IS NOT NULL)
      ${minCutoffClause}
      AND ${LEDGER_BILLING_CONDITION}
    GROUP BY ${usageLedger.userId}, kt.key_id
  `);

  const settledUserDec = new Map<number, Decimal>();
  const liveUserDec = new Map<number, Decimal>();
  const settledKeyDec = new Map<number, Decimal>();
  const liveKeyDec = new Map<number, Decimal>();

  for (const row of Array.from(rows) as Array<{
    user_id: unknown;
    key_id: unknown;
    settled_user_cost: unknown;
    live_user_cost: unknown;
    settled_key_cost: unknown;
    live_key_cost: unknown;
  }>) {
    const userId = Number(row.user_id);
    if (settledUserCosts.has(userId)) {
      if (row.settled_user_cost != null) {
        settledUserDec.set(
          userId,
          (settledUserDec.get(userId) ?? new Decimal(0)).plus(
            new Decimal(String(row.settled_user_cost))
          )
        );
      }
      if (row.live_user_cost != null) {
        liveUserDec.set(
          userId,
          (liveUserDec.get(userId) ?? new Decimal(0)).plus(new Decimal(String(row.live_user_cost)))
        );
      }
    }

    if (row.key_id != null) {
      const keyId = Number(row.key_id);
      if (settledKeyCosts.has(keyId)) {
        if (row.settled_key_cost != null) {
          settledKeyDec.set(
            keyId,
            (settledKeyDec.get(keyId) ?? new Decimal(0)).plus(
              new Decimal(String(row.settled_key_cost))
            )
          );
        }
        if (row.live_key_cost != null) {
          liveKeyDec.set(
            keyId,
            (liveKeyDec.get(keyId) ?? new Decimal(0)).plus(new Decimal(String(row.live_key_cost)))
          );
        }
      }
    }
  }

  for (const [id, total] of settledUserDec) settledUserCosts.set(id, total.toNumber());
  for (const [id, total] of liveUserDec) liveUserCosts.set(id, total.toNumber());
  for (const [id, total] of settledKeyDec) settledKeyCosts.set(id, total.toNumber());
  for (const [id, total] of liveKeyDec) liveKeyCosts.set(id, total.toNumber());

  return { settledUserCosts, settledKeyCosts, liveUserCosts, liveKeyCosts };
}

/**
 * 用于供应商总消费限额检查（limit_total_usd）。
 *
 * 重要语义：
 * - 总限额必须是“从 resetAt 起累计到现在”的结果；resetAt 为空时表示从历史最早记录开始累计。
 * - 这里不再做 365 天时间截断，否则会导致达到总限额后“过期自动恢复”，违背禁用语义。
 *
 * @param providerId - 供应商 ID
 * @param resetAt - 手动重置时间（用于实现“从 0 重新累计”）
 */
export async function sumProviderTotalCost(
  providerId: number,
  resetAt?: Date | null
): Promise<number> {
  const effectiveStart =
    resetAt instanceof Date && !Number.isNaN(resetAt.getTime()) ? resetAt : null;

  const result = await db
    .select({ total: sql<number>`COALESCE(SUM(${usageLedger.costUsd}), 0)` })
    .from(usageLedger)
    .where(
      and(
        eq(usageLedger.finalProviderId, providerId),
        LEDGER_BILLING_CONDITION,
        ...(effectiveStart ? [gte(usageLedger.createdAt, effectiveStart)] : [])
      )
    );

  return Number(result[0]?.total || 0);
}

/**
 * 查询用户在指定时间范围内的消费总和
 * 用于用户层限额百分比显示
 */
export async function sumUserCostInTimeRange(
  userId: number,
  startTime: Date,
  endTime: Date
): Promise<number> {
  const result = await db
    .select({ total: sql<number>`COALESCE(SUM(${usageLedger.costUsd}), 0)` })
    .from(usageLedger)
    .where(
      and(
        eq(usageLedger.userId, userId),
        gte(usageLedger.createdAt, startTime),
        lt(usageLedger.createdAt, endTime),
        LEDGER_BILLING_CONDITION
      )
    );

  return Number(result[0]?.total || 0);
}

/**
 * 查询 Key 在指定时间范围内的消费总和
 * 用于 Key 层限额检查（Redis 降级）
 */
export async function sumKeyCostInTimeRange(
  keyId: number,
  startTime: Date,
  endTime: Date
): Promise<number> {
  const keyString = await getKeyStringByIdCached(keyId);
  if (!keyString) return 0;

  const result = await db
    .select({ total: sql<number>`COALESCE(SUM(${usageLedger.costUsd}), 0)` })
    .from(usageLedger)
    .where(
      and(
        eq(usageLedger.key, keyString), // 使用 key 字符串而非 ID
        gte(usageLedger.createdAt, startTime),
        lt(usageLedger.createdAt, endTime),
        LEDGER_BILLING_CONDITION
      )
    );

  return Number(result[0]?.total || 0);
}

export interface QuotaCostRanges {
  range5h: { startTime: Date; endTime: Date };
  rangeDaily: { startTime: Date; endTime: Date };
  rangeWeekly: { startTime: Date; endTime: Date };
  rangeMonthly: { startTime: Date; endTime: Date };
}

interface QuotaCostSummary {
  cost5h: number;
  costDaily: number;
  costWeekly: number;
  costMonthly: number;
  costTotal: number;
}

/**
 * 合并查询：一次 SQL 返回用户各周期消费与总消费
 *
 * 说明：
 * - 通过 FILTER 子句避免多次往返/重复扫描
 * - scanStart/scanEnd 仅用于缩小扫描范围（不改变语义）
 * - total 使用 maxAgeDays 做时间截断（与 sumUserTotalCost 语义一致）
 */
export async function sumUserQuotaCosts(
  userId: number,
  ranges: QuotaCostRanges,
  maxAgeDays: number = 365,
  resetAt?: Date | null
): Promise<QuotaCostSummary> {
  const maxAgeCutoff =
    Number.isFinite(maxAgeDays) && maxAgeDays > 0
      ? new Date(Date.now() - Math.floor(maxAgeDays) * 24 * 60 * 60 * 1000)
      : null;
  // Use the more recent of maxAgeCutoff and resetAt
  let cutoffDate = maxAgeCutoff;
  if (resetAt instanceof Date && !Number.isNaN(resetAt.getTime())) {
    cutoffDate = maxAgeCutoff && maxAgeCutoff > resetAt ? maxAgeCutoff : resetAt;
  }

  const scanStart = cutoffDate
    ? new Date(
        Math.min(
          ranges.range5h.startTime.getTime(),
          ranges.rangeDaily.startTime.getTime(),
          ranges.rangeWeekly.startTime.getTime(),
          ranges.rangeMonthly.startTime.getTime(),
          cutoffDate.getTime()
        )
      )
    : null;
  const scanEnd = new Date(
    Math.max(
      ranges.range5h.endTime.getTime(),
      ranges.rangeDaily.endTime.getTime(),
      ranges.rangeWeekly.endTime.getTime(),
      ranges.rangeMonthly.endTime.getTime(),
      Date.now()
    )
  );

  const costTotal = cutoffDate
    ? sql<string>`COALESCE(SUM(${usageLedger.costUsd}) FILTER (WHERE ${usageLedger.createdAt} >= ${cutoffDate.toISOString()}), 0)`
    : sql<string>`COALESCE(SUM(${usageLedger.costUsd}), 0)`;

  const [row] = await db
    .select({
      cost5h: sql<string>`COALESCE(SUM(${usageLedger.costUsd}) FILTER (WHERE ${usageLedger.createdAt} >= ${ranges.range5h.startTime.toISOString()} AND ${usageLedger.createdAt} < ${ranges.range5h.endTime.toISOString()}), 0)`,
      costDaily: sql<string>`COALESCE(SUM(${usageLedger.costUsd}) FILTER (WHERE ${usageLedger.createdAt} >= ${ranges.rangeDaily.startTime.toISOString()} AND ${usageLedger.createdAt} < ${ranges.rangeDaily.endTime.toISOString()}), 0)`,
      costWeekly: sql<string>`COALESCE(SUM(${usageLedger.costUsd}) FILTER (WHERE ${usageLedger.createdAt} >= ${ranges.rangeWeekly.startTime.toISOString()} AND ${usageLedger.createdAt} < ${ranges.rangeWeekly.endTime.toISOString()}), 0)`,
      costMonthly: sql<string>`COALESCE(SUM(${usageLedger.costUsd}) FILTER (WHERE ${usageLedger.createdAt} >= ${ranges.rangeMonthly.startTime.toISOString()} AND ${usageLedger.createdAt} < ${ranges.rangeMonthly.endTime.toISOString()}), 0)`,
      costTotal,
    })
    .from(usageLedger)
    .where(
      and(
        eq(usageLedger.userId, userId),
        LEDGER_BILLING_CONDITION,
        ...(scanStart ? [gte(usageLedger.createdAt, scanStart)] : []),
        lt(usageLedger.createdAt, scanEnd)
      )
    );

  return {
    cost5h: Number(row?.cost5h ?? 0),
    costDaily: Number(row?.costDaily ?? 0),
    costWeekly: Number(row?.costWeekly ?? 0),
    costMonthly: Number(row?.costMonthly ?? 0),
    costTotal: Number(row?.costTotal ?? 0),
  };
}

/**
 * 合并查询：一次 SQL 返回 Key 各周期消费与总消费（通过 keyId）
 */
export async function sumKeyQuotaCostsById(
  keyId: number,
  ranges: QuotaCostRanges,
  maxAgeDays: number = 365,
  resetAt?: Date | null
): Promise<QuotaCostSummary> {
  const keyString = await getKeyStringByIdCached(keyId);
  if (!keyString) {
    return { cost5h: 0, costDaily: 0, costWeekly: 0, costMonthly: 0, costTotal: 0 };
  }

  const maxAgeCutoff =
    Number.isFinite(maxAgeDays) && maxAgeDays > 0
      ? new Date(Date.now() - Math.floor(maxAgeDays) * 24 * 60 * 60 * 1000)
      : null;
  // Use the more recent of maxAgeCutoff and resetAt
  let cutoffDate = maxAgeCutoff;
  if (resetAt instanceof Date && !Number.isNaN(resetAt.getTime())) {
    cutoffDate = maxAgeCutoff && maxAgeCutoff > resetAt ? maxAgeCutoff : resetAt;
  }

  const scanStart = cutoffDate
    ? new Date(
        Math.min(
          ranges.range5h.startTime.getTime(),
          ranges.rangeDaily.startTime.getTime(),
          ranges.rangeWeekly.startTime.getTime(),
          ranges.rangeMonthly.startTime.getTime(),
          cutoffDate.getTime()
        )
      )
    : null;
  const scanEnd = new Date(
    Math.max(
      ranges.range5h.endTime.getTime(),
      ranges.rangeDaily.endTime.getTime(),
      ranges.rangeWeekly.endTime.getTime(),
      ranges.rangeMonthly.endTime.getTime(),
      Date.now()
    )
  );

  const costTotal = cutoffDate
    ? sql<string>`COALESCE(SUM(${usageLedger.costUsd}) FILTER (WHERE ${usageLedger.createdAt} >= ${cutoffDate.toISOString()}), 0)`
    : sql<string>`COALESCE(SUM(${usageLedger.costUsd}), 0)`;

  const [row] = await db
    .select({
      cost5h: sql<string>`COALESCE(SUM(${usageLedger.costUsd}) FILTER (WHERE ${usageLedger.createdAt} >= ${ranges.range5h.startTime.toISOString()} AND ${usageLedger.createdAt} < ${ranges.range5h.endTime.toISOString()}), 0)`,
      costDaily: sql<string>`COALESCE(SUM(${usageLedger.costUsd}) FILTER (WHERE ${usageLedger.createdAt} >= ${ranges.rangeDaily.startTime.toISOString()} AND ${usageLedger.createdAt} < ${ranges.rangeDaily.endTime.toISOString()}), 0)`,
      costWeekly: sql<string>`COALESCE(SUM(${usageLedger.costUsd}) FILTER (WHERE ${usageLedger.createdAt} >= ${ranges.rangeWeekly.startTime.toISOString()} AND ${usageLedger.createdAt} < ${ranges.rangeWeekly.endTime.toISOString()}), 0)`,
      costMonthly: sql<string>`COALESCE(SUM(${usageLedger.costUsd}) FILTER (WHERE ${usageLedger.createdAt} >= ${ranges.rangeMonthly.startTime.toISOString()} AND ${usageLedger.createdAt} < ${ranges.rangeMonthly.endTime.toISOString()}), 0)`,
      costTotal,
    })
    .from(usageLedger)
    .where(
      and(
        eq(usageLedger.key, keyString),
        LEDGER_BILLING_CONDITION,
        ...(scanStart ? [gte(usageLedger.createdAt, scanStart)] : []),
        lt(usageLedger.createdAt, scanEnd)
      )
    );

  return {
    cost5h: Number(row?.cost5h ?? 0),
    costDaily: Number(row?.costDaily ?? 0),
    costWeekly: Number(row?.costWeekly ?? 0),
    costMonthly: Number(row?.costMonthly ?? 0),
    costTotal: Number(row?.costTotal ?? 0),
  };
}

export interface CostEntryInTimeRange {
  id: number;
  createdAt: Date;
  costUsd: number;
}

/**
 * 查询用户在指定时间范围内的消费明细（用于滚动窗口 Redis 恢复）
 */
export async function findUserCostEntriesInTimeRange(
  userId: number,
  startTime: Date,
  endTime: Date
): Promise<CostEntryInTimeRange[]> {
  const rows = await db
    .select({
      id: messageRequest.id,
      createdAt: messageRequest.createdAt,
      costUsd: messageRequest.costUsd,
    })
    .from(messageRequest)
    .where(
      and(
        eq(messageRequest.userId, userId),
        gte(messageRequest.createdAt, startTime),
        lt(messageRequest.createdAt, endTime),
        isNull(messageRequest.deletedAt),
        EXCLUDE_WARMUP_CONDITION
      )
    );

  return rows
    .map((row) => {
      if (!row.createdAt) return null;
      const costUsd = Number(row.costUsd || 0);
      if (!Number.isFinite(costUsd) || costUsd <= 0) return null;
      return { id: row.id, createdAt: row.createdAt, costUsd };
    })
    .filter((row): row is CostEntryInTimeRange => row !== null);
}

/**
 * 查询供应商在指定时间范围内的消费明细（用于滚动窗口 Redis 恢复）
 */
export async function findProviderCostEntriesInTimeRange(
  providerId: number,
  startTime: Date,
  endTime: Date
): Promise<CostEntryInTimeRange[]> {
  const rows = await db
    .select({
      id: messageRequest.id,
      createdAt: messageRequest.createdAt,
      costUsd: messageRequest.costUsd,
    })
    .from(messageRequest)
    .where(
      and(
        eq(messageRequest.providerId, providerId),
        gte(messageRequest.createdAt, startTime),
        lt(messageRequest.createdAt, endTime),
        isNull(messageRequest.deletedAt),
        EXCLUDE_WARMUP_CONDITION
      )
    );

  return rows
    .map((row) => {
      if (!row.createdAt) return null;
      const costUsd = Number(row.costUsd || 0);
      if (!Number.isFinite(costUsd) || costUsd <= 0) return null;
      return { id: row.id, createdAt: row.createdAt, costUsd };
    })
    .filter((row): row is CostEntryInTimeRange => row !== null);
}

/**
 * 查询 Key 在指定时间范围内的消费明细（用于滚动窗口 Redis 恢复）
 */
export async function findKeyCostEntriesInTimeRange(
  keyId: number,
  startTime: Date,
  endTime: Date
): Promise<CostEntryInTimeRange[]> {
  const keyString = await getKeyStringByIdCached(keyId);
  if (!keyString) return [];

  const rows = await db
    .select({
      id: messageRequest.id,
      createdAt: messageRequest.createdAt,
      costUsd: messageRequest.costUsd,
    })
    .from(messageRequest)
    .where(
      and(
        eq(messageRequest.key, keyString), // 使用 key 字符串而非 ID
        gte(messageRequest.createdAt, startTime),
        lt(messageRequest.createdAt, endTime),
        isNull(messageRequest.deletedAt),
        EXCLUDE_WARMUP_CONDITION
      )
    );

  return rows
    .map((row) => {
      if (!row.createdAt) return null;
      const costUsd = Number(row.costUsd || 0);
      if (!Number.isFinite(costUsd) || costUsd <= 0) return null;
      return { id: row.id, createdAt: row.createdAt, costUsd };
    })
    .filter((row): row is CostEntryInTimeRange => row !== null);
}

/**
 * 获取限流事件统计数据
 * 查询 message_request 表中包含 rate_limit_metadata 的错误记录
 *
 * @param filters - 过滤条件
 * @returns 聚合统计数据，包含 6 个维度的指标
 */
export async function getRateLimitEventStats(
  filters: RateLimitEventFilters = {}
): Promise<RateLimitEventStats> {
  const timezone = await resolveSystemTimezone();
  const { user_id, provider_id, limit_type, start_time, end_time, key_id } = filters;

  const conditions: SQL[] = [
    sql`${messageRequest.errorMessage} LIKE ${"%rate_limit_metadata%"}`,
    isNull(messageRequest.deletedAt),
  ];

  if (user_id !== undefined) {
    conditions.push(eq(messageRequest.userId, user_id));
  }

  if (provider_id !== undefined) {
    conditions.push(eq(messageRequest.providerId, provider_id));
  }

  const startIso = start_time?.toISOString();
  const endIso = end_time?.toISOString();

  if (startIso) {
    conditions.push(sql`${messageRequest.createdAt} >= ${startIso}::timestamptz`);
  }

  if (endIso) {
    conditions.push(sql`${messageRequest.createdAt} <= ${endIso}::timestamptz`);
  }

  // Key ID 过滤需要先查询 key 字符串
  let keyString: string | null = null;
  if (key_id !== undefined) {
    keyString = await getKeyStringByIdCached(key_id);
    if (keyString) {
      conditions.push(eq(messageRequest.key, keyString));
    } else {
      // Key 不存在，返回空统计
      return {
        total_events: 0,
        events_by_type: {} as Record<RateLimitType, number>,
        events_by_user: {},
        events_by_provider: {},
        events_timeline: [],
        avg_current_usage: 0,
      };
    }
  }

  // 查询所有符合条件的限流事件
  const query = sql`
    SELECT
      ${messageRequest.id},
      ${messageRequest.userId},
      ${messageRequest.providerId},
      ${messageRequest.errorMessage},
      DATE_TRUNC('hour', ${messageRequest.createdAt} AT TIME ZONE ${timezone}) AS hour
    FROM ${messageRequest}
    WHERE ${and(...conditions)}
    ORDER BY ${messageRequest.createdAt}
  `;

  const result = await db.execute(query);
  const rows = Array.from(result) as Array<{
    id: number;
    user_id: number;
    provider_id: number;
    error_message: string;
    hour: Date;
  }>;

  // 初始化聚合数据
  const eventsByType: Record<string, number> = {};
  const eventsByUser: Record<number, number> = {};
  const eventsByProvider: Record<number, number> = {};
  const eventsByHour: Record<string, number> = {};
  let totalCurrentUsage = 0;
  let usageCount = 0;

  // 处理每条记录
  for (const row of rows) {
    // 解析 rate_limit_metadata JSON
    const metadataMatch = row.error_message.match(/rate_limit_metadata:\s*(\{[^}]+\})/);
    if (!metadataMatch) {
      continue;
    }

    let metadata: { limit_type?: string; current?: number };
    try {
      metadata = JSON.parse(metadataMatch[1]);
    } catch {
      continue;
    }

    const rowLimitType = metadata.limit_type;
    const currentUsage = metadata.current;

    // 如果指定了 limit_type 过滤，跳过不匹配的记录
    if (limit_type && rowLimitType !== limit_type) {
      continue;
    }

    // 按类型统计
    if (rowLimitType) {
      eventsByType[rowLimitType] = (eventsByType[rowLimitType] || 0) + 1;
    }

    // 按用户统计
    eventsByUser[row.user_id] = (eventsByUser[row.user_id] || 0) + 1;

    // 按供应商统计
    eventsByProvider[row.provider_id] = (eventsByProvider[row.provider_id] || 0) + 1;

    // 按小时统计
    const hourKey = row.hour.toISOString();
    eventsByHour[hourKey] = (eventsByHour[hourKey] || 0) + 1;

    // 累计当前使用量
    if (typeof currentUsage === "number") {
      totalCurrentUsage += currentUsage;
      usageCount++;
    }
  }

  // 计算平均当前使用量
  const avgCurrentUsage = usageCount > 0 ? totalCurrentUsage / usageCount : 0;

  // 构建时间线数组（按时间排序）
  const eventsTimeline = Object.entries(eventsByHour)
    .map(([hour, count]) => ({ hour, count }))
    .sort((a, b) => a.hour.localeCompare(b.hour));

  return {
    total_events: rows.length,
    events_by_type: eventsByType as Record<RateLimitType, number>,
    events_by_user: eventsByUser,
    events_by_provider: eventsByProvider,
    events_timeline: eventsTimeline,
    avg_current_usage: Number(avgCurrentUsage.toFixed(2)),
  };
}

/**
 * 查询 Provider 在指定时间范围内的消费总和
 * 用于 Provider 层限额检查（Redis 降级）
 */
export async function sumProviderCostInTimeRange(
  providerId: number,
  startTime: Date,
  endTime: Date
): Promise<number> {
  const result = await db
    .select({ total: sql<number>`COALESCE(SUM(${usageLedger.costUsd}), 0)` })
    .from(usageLedger)
    .where(
      and(
        eq(usageLedger.finalProviderId, providerId),
        gte(usageLedger.createdAt, startTime),
        lt(usageLedger.createdAt, endTime),
        LEDGER_BILLING_CONDITION
      )
    );

  return Number(result[0]?.total || 0);
}
