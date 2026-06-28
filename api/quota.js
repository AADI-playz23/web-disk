// ── GET /api/quota?username=X&site_id=Y ──
// Returns full quota info: plan, session elapsed/remaining, weekly usage.
// Replaces quota.php

import { d1QueryOne } from './_lib/d1.js';
import { redisCmd, redisParseHash } from './_lib/redis.js';
import { getPlanLimits, getWeeklyUsage } from './_lib/plans.js';
import { requireAuth } from './_lib/middleware.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const user = requireAuth(req, res);
  if (!user) return;

  const username = user.username;
  const site_id  = parseInt(req.query.site_id, 10);

  if (!site_id) return res.status(400).json({ error: 'Missing params' });

  const key = `${username}_${site_id}`;
  const now = Math.floor(Date.now() / 1000);

  try {
    // 1. Fetch plan from D1
    const row  = await d1QueryOne('SELECT plan FROM users WHERE username = ?', [username]);
    const plan = row?.plan ?? 'starter';

    // 2. Plan limits
    const limits = getPlanLimits(plan);

    // 3. Weekly usage (auto-resets if 7 days elapsed)
    const usage = await getWeeklyUsage(redisCmd, redisParseHash, username, site_id);

    // 4. Current session from Redis
    const sessionData = await redisCmd(['HGETALL', `session:${key}`]);
    const session     = redisParseHash(sessionData);

    const status        = session.status ?? 'offline';
    const session_start = parseInt(session.session_start ?? 0, 10);

    let session_elapsed   = 0;
    let session_remaining = limits.session;

    if (session_start > 0 && status === 'live') {
      session_elapsed   = now - session_start;
      session_remaining = Math.max(0, limits.session - session_elapsed);
    }

    const weekly_remaining = Math.max(0, limits.weekly - usage.weekly_seconds);
    const week_resets_at   = usage.week_start + 604800;

    return res.status(200).json({
      plan,
      status,
      session_elapsed,
      session_remaining,
      session_limit:    limits.session,
      weekly_used:      usage.weekly_seconds,
      weekly_remaining,
      weekly_limit:     limits.weekly,
      weekly_resets_at: week_resets_at,
    });
  } catch (err) {
    console.error('[quota]', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
