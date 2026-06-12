// ── GET /api/account?username=X ──
// Returns plan info + aggregated weekly usage.
// Replaces account.php

import { d1QueryOne } from './_lib/d1.js';
import { redisCmd, redisParseHash } from './_lib/redis.js';
import { getSlotsForPlan, getPlanLimits, getWeeklyUsage } from './_lib/plans.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const username = (req.query.username ?? '').replace(/[^a-zA-Z0-9-]/g, '');
  if (!username) {
    return res.status(200).json({ plan: 'starter', slots: 1 });
  }

  try {
    const row  = await d1QueryOne('SELECT plan FROM users WHERE username = ?', [username]);
    const plan = row?.plan ?? 'starter';

    const slots  = getSlotsForPlan(plan);
    const limits = getPlanLimits(plan);

    // Aggregate weekly usage across all slots
    let total_weekly_used = 0;
    for (let i = 1; i <= slots; i++) {
      const usage = await getWeeklyUsage(redisCmd, redisParseHash, username, i);
      total_weekly_used += usage.weekly_seconds;
    }

    return res.status(200).json({
      plan,
      slots,
      session_limit:    limits.session,
      weekly_limit:     limits.weekly,
      weekly_used:      total_weekly_used,
      weekly_remaining: Math.max(0, limits.weekly - total_weekly_used),
    });
  } catch (err) {
    console.error('[account]', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
