// ── Plan Configuration ──
// Ported from db.php — plan limits, slots, storage, weekly usage tracking.

/**
 * Plan → max concurrent slots.
 */
export function getSlotsForPlan(plan) {
  const map = { starter: 1, developer: 1, professional: 2, studio: 3 };
  return map[plan] ?? 1;
}

/**
 * Plan → time limits (seconds).
 *   session = max duration per boot
 *   weekly  = total seconds per rolling 7-day window
 */
export function getPlanLimits(plan) {
  const limits = {
    starter:      { session: 3600,  weekly: 36000  },  // 1h / 10h
    developer:    { session: 10800, weekly: 86400  },  // 3h / 24h
    professional: { session: 10800, weekly: 86400  },  // 3h / 24h
    studio:       { session: 21600, weekly: 108000 },  // 6h / 30h
  };
  return limits[plan] ?? limits.starter;
}

/**
 * Plan → storage quota in bytes.
 */
export function getStorageQuota(plan) {
  const map = {
    starter:      500  * 1024 * 1024,            // 500 MB
    developer:    50   * 1024 * 1024 * 1024,     // 50 GB
    professional: 200  * 1024 * 1024 * 1024,     // 200 GB
    studio:       1024 * 1024 * 1024 * 1024,     // 1 TB
  };
  return map[plan] ?? map.starter;
}

/**
 * Plan price map (INR) for Gemini payment verification.
 */
export const PLAN_PRICES_INR = {
  developer:    415,
  professional: 1080,
  studio:       2080,
};

/**
 * Get weekly usage for a specific user slot from Redis.
 * Auto-resets if 7 days have elapsed.
 * @param {Function} redisCmd - the redisCmd helper
 * @param {Function} redisParseHash - the redisParseHash helper
 * @returns {Promise<{weekly_seconds: number, week_start: number}>}
 */
export async function getWeeklyUsage(redisCmd, redisParseHash, username, siteId) {
  const key  = `usage:${username}_${siteId}`;
  const data = await redisCmd(['HGETALL', key]);
  const parsed = redisParseHash(data);

  const now = Math.floor(Date.now() / 1000);

  if (!parsed || Object.keys(parsed).length === 0) {
    await redisCmd(['HSET', key, 'weekly_seconds', '0', 'week_start', String(now)]);
    return { weekly_seconds: 0, week_start: now };
  }

  const week_start     = parseInt(parsed.week_start     ?? now, 10);
  const weekly_seconds = parseInt(parsed.weekly_seconds ?? 0,   10);

  // Rolling 7-day window — reset if ≥ 604800 seconds have passed
  if (now - week_start >= 604800) {
    await redisCmd(['HSET', key, 'weekly_seconds', '0', 'week_start', String(now)]);
    return { weekly_seconds: 0, week_start: now };
  }

  return { weekly_seconds, week_start };
}
