// ── GET /api/status?username=X&site_id=Y ──
// Returns slot status from Redis, with stale runner detection.
// Replaces status.php

import { redisCmd, redisParseHash } from './_lib/redis.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const username = (req.query.username ?? '').replace(/[^a-zA-Z0-9-]/g, '');
  const site_id  = parseInt(req.query.site_id, 10);

  if (!username || !site_id) return res.status(200).json({ status: 'offline' });

  const key = `${username}_${site_id}`;
  const now = Math.floor(Date.now() / 1000);

  try {
    const sessionData = await redisCmd(['HGETALL', `session:${key}`]);
    const session     = redisParseHash(sessionData);
    let status        = session.status ?? 'offline';

    // ── Stale runner detection ──
    if (status === 'live' || status === 'booting') {
      const runner_id = session.runner_id ?? '';
      let is_stale = false;

      if (runner_id) {
        const hb = await redisCmd(['HGET', `runner:${runner_id}`, 'heartbeat']);
        if (!hb || (now - parseInt(hb, 10)) > 120) is_stale = true;
      } else if (status === 'booting') {
        const session_start = parseInt(session.session_start ?? 0, 10);
        if (session_start > 0 && (now - session_start) > 300) is_stale = true;
      } else if (status === 'live' && !runner_id) {
        is_stale = true;
      }

      if (is_stale) {
        await redisCmd(['HSET', `session:${key}`, 'status', 'offline', 'url', '']);
        status = 'offline';
        if (runner_id) {
          await redisCmd(['SREM', 'runners:active', runner_id]);
          await redisCmd(['DEL', `runner:${runner_id}`]);
          await redisCmd(['DEL', `runner:${runner_id}:slots`]);
        }
      }
    }

    const response = { status };
    if (status === 'live' && session.url) response.url = session.url;

    return res.status(200).json(response);
  } catch (err) {
    console.error('[status]', err);
    return res.status(500).json({ status: 'offline' });
  }
}
